// hook_dll.c —— 进程隔离 hook DLL 核心
//
// 功能：
// 1. Mutex/Event/Semaphore/Section 命名空间隔离（绕过单实例锁）
// 2. 文件路径重定向（每个 box 独立配置目录）
// 3. 注册表重定向（每个 box 独立注册表分支）
//
// 原理：通过 MinHook 库拦截 ntdll.dll 的 Nt* 系列函数，
// 在调用前修改参数（对象名/文件路径/注册表路径），实现隔离。
//
// 许可证：本项目使用 MIT 许可证。MinHook 库使用 BSD 许可证（可商用）。
// 不依赖 Sandboxie 或任何 GPL 代码，完全自研实现。

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winreg.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "ntdll_types.h"
#include "../minhook/include/MinHook.h"

// 自动链接 advapi32.lib（RegCreateKeyExW/RegSetValueExW/RegCloseKey 所在库）
#pragma comment(lib, "advapi32.lib")

// 启用 hook 的开关（通过环境变量控制）
static BOOL g_hookEnabled = FALSE;
static WCHAR g_boxPrefix[64] = { 0 };       // box 前缀（如 L"BOX_App-1_"）
static WCHAR g_redirectBase[MAX_PATH] = { 0 }; // 文件重定向根目录
static WCHAR g_sharedDir[MAX_PATH] = { 0 };    // 共享目录（不重定向）
static WCHAR g_appPath[MAX_PATH] = { 0 };      // box 内应用路径（用于识别 launcher 派生的子进程）
static WCHAR g_thisDllPath[MAX_PATH] = { 0 };  // hook DLL 自己的路径（用于传播注入到子进程）
static WCHAR g_browserPath[MAX_PATH] = { 0 };  // 浏览器路径（Chrome/Edge，用于 URL 重定向）
static WCHAR g_browserUserDataDir[MAX_PATH] = { 0 }; // 浏览器独立 user-data-dir
static HANDLE g_initCompleteEvent = NULL;             // injector/child startup handshake
static WCHAR g_tzKeyPath[256] = { 0 };   // 重定向后的时区注册表路径
static WCHAR g_tzStdName[64] = { 0 };    // 时区标准名称（用于写入注册表）

// ---- MachineGuid 隔离（句柄追踪 + NtQueryValueKey hook） ----
// 不再依赖写 HKLM 注册表（需要管理员权限），改为追踪 Cryptography 键句柄，
// 在 NtQueryValueKey 时直接返回伪造的 MachineGuid 值。
static WCHAR g_fakeMachineGuid[64] = { 0 };  // 从 MULTIOPEN_MACHINE_GUID 读取的伪造 GUID
#define MAX_CRYPTO_HANDLES 64
static HANDLE g_cryptoKeyHandles[MAX_CRYPTO_HANDLES] = { 0 };  // 追踪的 Cryptography 键句柄
static int g_cryptoHandleCount = 0;

// ---- 旧版设备兼容字段（当前不安装对应 hooks） ----
// 保留实现仅用于读取旧实例数据；受支持的运行时边界不伪造物理设备身份。
static WCHAR g_fakeComputerName[64] = { 0 };  // 从 MULTIOPEN_HOSTNAME 读取的伪造计算机名
// Per-instance SMBIOS system UUID. Trae/Aha derives its native local device
// identity from the raw SMBIOS table, so MachineGuid alone is insufficient.
static BYTE g_fakeSmbiosUuid[16] = { 0 };
static BOOL g_hasFakeSmbiosUuid = FALSE;

// 日志输出（调试用，发布版可关闭）
#ifdef HOOK_DEBUG
static void HookLog(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[512];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    OutputDebugStringA("[HookDLL] ");
    OutputDebugStringA(buf);
    OutputDebugStringA("\n");
}
#else
static __declspec(thread) BOOL g_inHookLog = FALSE;
static void HookLog(const char* fmt, ...) {
    if (g_inHookLog) return;
    g_inHookLog = TRUE;

    char buf[512] = { 0 };
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);

    char base[MAX_PATH] = { 0 };
    DWORD len = GetEnvironmentVariableA("MULTIOPEN_REDIRECT_BASE", base, sizeof(base));
    if (len > 0 && len < sizeof(base)) {
        char logPath[MAX_PATH] = { 0 };
        _snprintf(logPath, sizeof(logPath) - 1, "%s\\hook-v3.log", base);
        WIN32_FILE_ATTRIBUTE_DATA info = { 0 };
        BOOL underLimit = TRUE;
        if (GetFileAttributesExA(logPath, GetFileExInfoStandard, &info)) {
            ULONGLONG size = ((ULONGLONG)info.nFileSizeHigh << 32) | info.nFileSizeLow;
            underLimit = size < (4ULL * 1024ULL * 1024ULL);
        }
        if (underLimit) {
            FILE* file = fopen(logPath, "a");
            if (file) {
                fprintf(file, "pid=%lu %s\n", GetCurrentProcessId(), buf);
                fclose(file);
            }
        }
    }
    OutputDebugStringA("[HookDLL] ");
    OutputDebugStringA(buf);
    OutputDebugStringA("\n");
    g_inHookLog = FALSE;
}
#endif

// 前向声明（LoadConfig 中调用，定义在后面）
static void CreateRedirectedTimezoneKey(void);
static void LoadFakeMachineGuid(void);
static void LoadFakeComputerName(void);
static void LoadFakeSmbiosUuid(void);
// ShellExecute hook 前向声明（定义在文件后部）
static HINSTANCE WINAPI HookShellExecuteW(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT);
static BOOL WINAPI HookShellExecuteExW(LPSHELLEXECUTEINFOW);
static HINSTANCE (WINAPI *OriginalShellExecuteW)(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT);
static BOOL (WINAPI *OriginalShellExecuteExW)(LPSHELLEXECUTEINFOW);

// Edge 的顶层 msedge.exe 可能只是 launcher，配套 msedge_elf.dll 在版本目录。
// 启动重定向前将路径归一化到“exe + elf DLL”同目录的完整版本目录，避免
// Windows loader 因当前目录是实例目录而找不到 msedge_elf.dll。
static BOOL ResolveBrowserExecutable(LPCWSTR configuredPath, LPWSTR outPath, DWORD outSize) {
    if (!configuredPath || !configuredPath[0] || !outPath || outSize < 2) return FALSE;

    WCHAR parent[MAX_PATH] = { 0 };
    wcsncpy(parent, configuredPath, MAX_PATH - 1);
    WCHAR* slash = wcsrchr(parent, L'\\');
    if (!slash) {
        wcsncpy(outPath, configuredPath, outSize - 1);
        outPath[outSize - 1] = L'\0';
        return TRUE;
    }
    *slash = L'\0';

    WCHAR elfPath[MAX_PATH] = { 0 };
    _snwprintf(elfPath, MAX_PATH - 1, L"%s\\msedge_elf.dll", parent);
    if (GetFileAttributesW(elfPath) != INVALID_FILE_ATTRIBUTES) {
        wcsncpy(outPath, configuredPath, outSize - 1);
        outPath[outSize - 1] = L'\0';
        return TRUE;
    }

    WCHAR search[MAX_PATH] = { 0 };
    _snwprintf(search, MAX_PATH - 1, L"%s\\*", parent);
    WIN32_FIND_DATAW data;
    HANDLE find = FindFirstFileW(search, &data);
    if (find == INVALID_HANDLE_VALUE) return FALSE;

    WCHAR best[MAX_PATH] = { 0 };
    do {
        if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        if (data.cFileName[0] == L'.') continue;
        WCHAR candidateExe[MAX_PATH] = { 0 };
        WCHAR candidateElf[MAX_PATH] = { 0 };
        _snwprintf(candidateExe, MAX_PATH - 1, L"%s\\%s\\msedge.exe", parent, data.cFileName);
        _snwprintf(candidateElf, MAX_PATH - 1, L"%s\\%s\\msedge_elf.dll", parent, data.cFileName);
        if (GetFileAttributesW(candidateExe) != INVALID_FILE_ATTRIBUTES &&
            GetFileAttributesW(candidateElf) != INVALID_FILE_ATTRIBUTES &&
            (!best[0] || wcscmp(data.cFileName, wcsrchr(best, L'\\') + 1) > 0)) {
            wcsncpy(best, candidateExe, MAX_PATH - 1);
            best[MAX_PATH - 1] = L'\0';
        }
    } while (FindNextFileW(find, &data));
    FindClose(find);

    if (!best[0]) return FALSE;
    wcsncpy(outPath, best, outSize - 1);
    outPath[outSize - 1] = L'\0';
    return TRUE;
}

// ==================== 配置初始化 ====================

static void LoadConfig(void) {
    // 从环境变量读取 box 名（由 Node.js spawn 时设置）
    char boxName[128] = { 0 };
    DWORD len = GetEnvironmentVariableA("MULTIOPEN_BOX_NAME", boxName, sizeof(boxName));
    if (len == 0 || len >= sizeof(boxName)) {
        HookLog("No MULTIOPEN_BOX_NAME env var, hooks disabled");
        return;
    }

    // 构建 box 前缀（用于命名空间隔离）
    // 格式：BOX_App-1_（大写，确保不与现有名字冲突）
    char prefix[160];
    snprintf(prefix, sizeof(prefix), "BOX_%s_", boxName);
    MultiByteToWideChar(CP_UTF8, 0, prefix, -1, g_boxPrefix, 64);

    // 读取文件重定向根目录
    len = GetEnvironmentVariableA("MULTIOPEN_REDIRECT_BASE", boxName, sizeof(boxName));
    if (len > 0 && len < sizeof(boxName)) {
        MultiByteToWideChar(CP_UTF8, 0, boxName, -1, g_redirectBase, MAX_PATH);
    }

    // 读取共享目录（不重定向的路径）
    len = GetEnvironmentVariableA("MULTIOPEN_SHARED_DIR", boxName, sizeof(boxName));
    if (len > 0 && len < sizeof(boxName)) {
        MultiByteToWideChar(CP_UTF8, 0, boxName, -1, g_sharedDir, MAX_PATH);
    }

    // 读取 box 内应用路径（用于识别 launcher 派生的子进程 → 注入 hook DLL）
    char appPathUtf8[MAX_PATH] = { 0 };
    len = GetEnvironmentVariableA("MULTIOPEN_APP_PATH", appPathUtf8, sizeof(appPathUtf8));
    if (len > 0 && len < sizeof(appPathUtf8)) {
        MultiByteToWideChar(CP_UTF8, 0, appPathUtf8, -1, g_appPath, MAX_PATH);
    }

    // 记录 hook DLL 自己的完整路径（用于传播注入到 launcher 派生的子进程）
    HMODULE hThisDll = NULL;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)&LoadConfig, &hThisDll)) {
        if (hThisDll && GetModuleFileNameW(hThisDll, g_thisDllPath, MAX_PATH) > 0) {
            HookLog("Hook DLL path: %S", g_thisDllPath);
        }
    }

    // 读取浏览器路径（Chrome/Edge，用于 URL 重定向）
    // 如果实例应用不是浏览器（如 Trae/VSCode），需要用真正的浏览器来打开 URL
    char browserPathUtf8[MAX_PATH] = { 0 };
    len = GetEnvironmentVariableA("MULTIOPEN_BROWSER_PATH", browserPathUtf8, sizeof(browserPathUtf8));
    if (len > 0 && len < sizeof(browserPathUtf8)) {
        MultiByteToWideChar(CP_UTF8, 0, browserPathUtf8, -1, g_browserPath, MAX_PATH);
        WCHAR resolvedBrowserPath[MAX_PATH] = { 0 };
        if (ResolveBrowserExecutable(g_browserPath, resolvedBrowserPath, MAX_PATH)) {
            wcsncpy(g_browserPath, resolvedBrowserPath, MAX_PATH - 1);
            g_browserPath[MAX_PATH - 1] = L'\0';
        }
        HookLog("Browser path for URL redirect: %S", g_browserPath);
    }

    // 读取浏览器独立 user-data-dir（避免与 IDE 的 Chromium 数据冲突）
    char browserDataDirUtf8[MAX_PATH] = { 0 };
    len = GetEnvironmentVariableA("MULTIOPEN_BROWSER_USER_DATA_DIR", browserDataDirUtf8, sizeof(browserDataDirUtf8));
    if (len > 0 && len < sizeof(browserDataDirUtf8)) {
        MultiByteToWideChar(CP_UTF8, 0, browserDataDirUtf8, -1, g_browserUserDataDir, MAX_PATH);
    }

    g_hookEnabled = TRUE;
    HookLog("Hooks enabled, box prefix: %S", g_boxPrefix);

    // 创建重定向的时区注册表键（用于隔离 GetTimeZoneInformation API）
    CreateRedirectedTimezoneKey();

    // 读取伪造的 MachineGuid（用于 NtQueryValueKey hook，不需要写 HKLM）
    LoadFakeMachineGuid();

    // 读取伪造的计算机名（用于 GetComputerNameW/GetComputerNameExW hook）
    LoadFakeComputerName();
    // Aha reads the raw SMBIOS system UUID during native device discovery.
    LoadFakeSmbiosUuid();
}

// ==================== 时区注册表重定向 ====================
//
// 问题：Windows 的 GetTimeZoneInformation() API 读取注册表
//   HKLM\System\CurrentControlSet\Control\TimeZoneInformation
// Chromium 和其他应用通过此 API 获取系统时区，环境变量 TZ 在 Windows 上无效。
//
// 方案：
// 1. 在 LoadConfig 中，根据 MULTIOPEN_TZ 环境变量创建 box 专属的时区注册表键
//    （如 BOX_App-1_TimeZoneInformation），写入正确的 Bias/StandardName 等
// 2. Hook NtCreateKey/NtOpenKey，当检测到打开 TimeZoneInformation 键时，
//    重定向到 box 专属键，使 GetTimeZoneInformation() 读取到 box 专属时区

// IANA 时区 → UTC 偏移（分钟，东为正）查找表
// Windows Bias = -UTC_OFFSET（西为正）
typedef struct { const char* iana; int utcOffsetMin; const wchar_t* stdName; } TzEntry;
static const TzEntry TZ_TABLE[] = {
    {"Asia/Shanghai",    480,  L"China Standard Time"},
    {"Asia/Hong_Kong",   480,  L"China Standard Time"},
    {"Asia/Taipei",      480,  L"Taipei Standard Time"},
    {"Asia/Tokyo",       540,  L"Tokyo Standard Time"},
    {"Asia/Seoul",       540,  L"Korea Standard Time"},
    {"Asia/Singapore",   480,  L"Singapore Standard Time"},
    {"Asia/Bangkok",     420,  L"SE Asia Standard Time"},
    {"Asia/Kuala_Lumpur",480,  L"Singapore Standard Time"},
    {"Asia/Manila",      480,  L"Singapore Standard Time"},
    {"Asia/Jakarta",     420,  L"SE Asia Standard Time"},
    {"Asia/Ho_Chi_Minh", 420,  L"SE Asia Standard Time"},
    {"Asia/Kolkata",     330,  L"India Standard Time"},
    {"Asia/Dubai",       240,  L"Arabian Standard Time"},
    {"Asia/Tehran",      210,  L"Iran Standard Time"},
    {"Asia/Riyadh",      180,  L"Arab Standard Time"},
    {"America/New_York", -300, L"Eastern Standard Time"},
    {"America/Los_Angeles",-480,L"Pacific Standard Time"},
    {"America/Chicago",  -360, L"Central Standard Time"},
    {"America/Denver",   -420, L"Mountain Standard Time"},
    {"America/Toronto",  -300, L"Eastern Standard Time"},
    {"America/Vancouver",-480, L"Pacific Standard Time"},
    {"America/Mexico_City",-360,L"Central Standard Time"},
    {"America/Sao_Paulo",-180, L"E. South America Standard Time"},
    {"America/Buenos_Aires",-180,L"Argentina Standard Time"},
    {"America/Santiago", -240, L"Pacific SA Standard Time"},
    {"Europe/London",    0,    L"GMT Standard Time"},
    {"Europe/Berlin",    60,   L"W. Europe Standard Time"},
    {"Europe/Paris",     60,   L"Romance Standard Time"},
    {"Europe/Madrid",    60,   L"Romance Standard Time"},
    {"Europe/Rome",      60,   L"W. Europe Standard Time"},
    {"Europe/Amsterdam", 60,   L"W. Europe Standard Time"},
    {"Europe/Stockholm", 60,   L"W. Europe Standard Time"},
    {"Europe/Moscow",    180,  L"Russian Standard Time"},
    {"Europe/Istanbul",  180,  L"Turkish Standard Time"},
    {"Europe/Warsaw",    60,   L"Central European Standard Time"},
    {"Europe/Athens",    120,  L"GTB Standard Time"},
    {"Australia/Sydney", 600,  L"AUS Eastern Standard Time"},
    {"Australia/Melbourne",600,L"AUS Eastern Standard Time"},
    {"Australia/Perth",  480,  L"W. Australia Standard Time"},
    {"Pacific/Auckland", 720,  L"New Zealand Standard Time"},
    {"Africa/Johannesburg",120,L"South Africa Standard Time"},
    {"Africa/Cairo",     120,  L"Egypt Standard Time"},
    {"Africa/Lagos",     60,   L"W. Central Africa Standard Time"},
    {"Africa/Nairobi",   180,  L"E. Africa Standard Time"},
    {"Pacific/Honolulu", -600, L"Hawaiian Standard Time"},
    {"America/Anchorage",-540, L"Alaskan Standard Time"},
    {"Asia/Karachi",     300,  L"Pakistan Standard Time"},
    {"Asia/Dhaka",       360,  L"Bangladesh Standard Time"},
    {"Asia/Chongqing",   480,  L"China Standard Time"},
    {"Asia/Urumqi",      360,  L"Central Asia Standard Time"},
    {NULL, 0, NULL}  // 哨兵
};

/** 根据 IANA 时区名查找 UTC 偏移和标准名称 */
static BOOL LookupTimezone(const char* iana, int* outOffset, WCHAR* outName, size_t nameSize) {
    for (int i = 0; TZ_TABLE[i].iana; i++) {
        if (_stricmp(iana, TZ_TABLE[i].iana) == 0) {
            *outOffset = TZ_TABLE[i].utcOffsetMin;
            wcsncpy(outName, TZ_TABLE[i].stdName, nameSize - 1);
            outName[nameSize - 1] = L'\0';
            return TRUE;
        }
    }
    return FALSE;
}

/** 创建 box 专属的时区注册表键，写入正确的 Bias/StandardName 等 */
static void CreateRedirectedTimezoneKey(void) {
    char tz[64] = { 0 };
    DWORD len = GetEnvironmentVariableA("MULTIOPEN_TZ", tz, sizeof(tz));
    if (len == 0 || len >= sizeof(tz)) {
        HookLog("No MULTIOPEN_TZ env var, timezone registry hook disabled");
        return;
    }

    // 查找时区偏移
    int utcOffset = 0;
    WCHAR stdName[64] = { 0 };
    if (!LookupTimezone(tz, &utcOffset, stdName, 64)) {
        HookLog("Unknown timezone '%s', using UTC", tz);
        utcOffset = 0;
        wcscpy(stdName, L"UTC");
    }

    // Windows Bias = -UTC_OFFSET（西为正，东为负）
    LONG bias = -utcOffset;
    LONG standardBias = 0;
    LONG daylightBias = 0;

    // 构建 box 专属键名（用 g_boxPrefix，格式 BOX_App-1_）
    // 注册表路径：HKLM\System\CurrentControlSet\Control\<boxPrefix>TimeZoneInformation
    WCHAR keySubPath[256];
    _snwprintf(keySubPath, 256, L"System\\CurrentControlSet\\Control\\%sTimeZoneInformation", g_boxPrefix);

    // 创建注册表键并写入时区信息
    HKEY hKey = NULL;
    DWORD disposition = 0;
    LONG result = RegCreateKeyExW(HKEY_LOCAL_MACHINE, keySubPath, 0, NULL, 0,
                                  KEY_WRITE, NULL, &hKey, &disposition);
    if (result != ERROR_SUCCESS) {
        // 写 HKLM 失败（通常是非管理员权限）：不设置 g_tzKeyPath，
        // 这样 RewriteTimeZoneKeyPath 不会重定向，应用读到真实时区（浏览器层 JS 覆盖仍生效）
        HookLog("Failed to create timezone registry key (err=%ld), timezone registry hook disabled", result);
        return;
    }

    // 仅在注册表键创建成功后才设置重定向路径（避免重定向到不存在的键）
    _snwprintf(g_tzKeyPath, 256, L"\\Registry\\Machine\\System\\CurrentControlSet\\Control\\%sTimeZoneInformation", g_boxPrefix);
    wcscpy(g_tzStdName, stdName);

    RegSetValueExW(hKey, L"Bias", 0, REG_DWORD, (BYTE*)&bias, sizeof(bias));
    RegSetValueExW(hKey, L"StandardName", 0, REG_SZ, (BYTE*)stdName, (DWORD)((wcslen(stdName) + 1) * sizeof(WCHAR)));
    RegSetValueExW(hKey, L"DaylightName", 0, REG_SZ, (BYTE*)stdName, (DWORD)((wcslen(stdName) + 1) * sizeof(WCHAR)));
    RegSetValueExW(hKey, L"StandardBias", 0, REG_DWORD, (BYTE*)&standardBias, sizeof(standardBias));
    RegSetValueExW(hKey, L"DaylightBias", 0, REG_DWORD, (BYTE*)&daylightBias, sizeof(daylightBias));
    // 禁用 DST（TimeZoneInformation 中的 DisableAutoDaylightTimeSet = 1）
    DWORD disableDST = 1;
    RegSetValueExW(hKey, L"DisableAutoDaylightTimeSet", 0, REG_DWORD, (BYTE*)&disableDST, sizeof(disableDST));

    RegCloseKey(hKey);
    HookLog("Created timezone registry key: %S (bias=%ld)", keySubPath, bias);
}

// ==================== MachineGuid 隔离（句柄追踪 + NtQueryValueKey hook） ====================
//
// 问题：Windows 的 MachineGuid（HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid）
//   是系统级设备唯一标识，很多平台用它做设备识别。
//   多个实例共享同一个 MachineGuid → 平台判定为同一设备 → "当前设备已签到"
//
// 旧方案的致命缺陷：
//   旧方案在 HKLM 下创建 box 专属子键并重定向，但写 HKLM 需要管理员权限。
//   普通权限下 RegCreateKeyExW(HKEY_LOCAL_MACHINE,...) 返回 ERROR_ACCESS_DENIED，
//   但 g_cryptoKeyPath 已被赋值 → hook 把 Cryptography 键重定向到一个不存在的键
//   → 应用 RegOpenKeyExW 失败 → 读不到 MachineGuid → 所有实例行为一致 → 仍被识别为同一设备。
//
// 新方案（不需要管理员权限，完全用户态）：
// 1. LoadConfig 中从 MULTIOPEN_MACHINE_GUID 环境变量读取伪造 GUID（不写注册表）
// 2. Hook NtOpenKey/NtCreateKey：当应用打开 Cryptography 键时，返回真实键句柄（不重定向），
//    但把句柄记录到追踪表
// 3. Hook NtQueryValueKey：当查询追踪句柄的 MachineGuid 值时，直接返回伪造 GUID
// 4. Hook NtClose：句柄关闭时从追踪表移除
//
// 此方案对应用透明：应用正常打开 Cryptography 键、正常查询值，
// 只是 MachineGuid 值被替换为 box 专属的伪造值。

/** 从 MULTIOPEN_MACHINE_GUID 环境变量读取伪造 GUID */
static void LoadFakeMachineGuid(void) {
    char guid[64] = { 0 };
    DWORD len = GetEnvironmentVariableA("MULTIOPEN_MACHINE_GUID", guid, sizeof(guid));
    if (len == 0 || len >= sizeof(guid)) {
        HookLog("No MULTIOPEN_MACHINE_GUID env var, MachineGuid hook disabled");
        return;
    }
    MultiByteToWideChar(CP_UTF8, 0, guid, -1, g_fakeMachineGuid, 64);
    HookLog("Fake MachineGuid loaded: %S", g_fakeMachineGuid);
}

/** 从 MULTIOPEN_HOSTNAME 环境变量读取伪造计算机名 */
static void LoadFakeComputerName(void) {
    char name[64] = { 0 };
    DWORD len = GetEnvironmentVariableA("MULTIOPEN_HOSTNAME", name, sizeof(name));
    if (len == 0 || len >= sizeof(name)) {
        HookLog("No MULTIOPEN_HOSTNAME env var, computer name hook disabled");
        return;
    }
    MultiByteToWideChar(CP_UTF8, 0, name, -1, g_fakeComputerName, 64);
    HookLog("Fake computer name loaded: %S", g_fakeComputerName);
}

static int HexValue(WCHAR ch) {
    if (ch >= L'0' && ch <= L'9') return (int)(ch - L'0');
    if (ch >= L'a' && ch <= L'f') return (int)(ch - L'a') + 10;
    if (ch >= L'A' && ch <= L'F') return (int)(ch - L'A') + 10;
    return -1;
}

/** Convert the instance MachineGuid into a stable 16-byte SMBIOS UUID. */
static void LoadFakeSmbiosUuid(void) {
    WCHAR guid[64] = { 0 };
    WCHAR hex[33] = { 0 };
    DWORD len = GetEnvironmentVariableW(L"MULTIOPEN_MACHINE_GUID", guid, 64);
    if (len == 0 || len >= 64) {
        HookLog("No MULTIOPEN_MACHINE_GUID env var, SMBIOS hook disabled");
        return;
    }

    int count = 0;
    for (DWORD i = 0; i < len && count < 32; i++) {
        if (HexValue(guid[i]) >= 0) hex[count++] = guid[i];
    }
    if (count != 32) {
        HookLog("Invalid MULTIOPEN_MACHINE_GUID, SMBIOS hook disabled");
        return;
    }

    for (int i = 0; i < 16; i++) {
        int hi = HexValue(hex[i * 2]);
        int lo = HexValue(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) return;
        g_fakeSmbiosUuid[i] = (BYTE)((hi << 4) | lo);
    }
    g_hasFakeSmbiosUuid = TRUE;
    HookLog("Per-instance SMBIOS UUID loaded");
}

// ==================== GetComputerNameW / GetComputerNameExW hook ====================
//
// Trae IDE 在 exchangeToken 请求中发送 DeviceName=GetComputerNameW() 返回值，
// 服务器通过此值识别设备。多实例共享同一计算机名 → 被识别为同一设备 → "设备已签到"。
// Hook GetComputerNameW/GetComputerNameExW 返回 box 专属的伪造计算机名。

static BOOL (WINAPI *OriginalGetComputerNameW)(LPWSTR lpBuffer, LPDWORD nSize) = NULL;
static BOOL (WINAPI *OriginalGetComputerNameExW)(COMPUTER_NAME_FORMAT NameType, LPWSTR lpBuffer, LPDWORD nSize) = NULL;

static BOOL WINAPI HookGetComputerNameW(LPWSTR lpBuffer, LPDWORD nSize) {
    if (!g_hookEnabled || !g_fakeComputerName[0]) {
        return OriginalGetComputerNameW(lpBuffer, nSize);
    }
    // 伪造计算机名（不含末尾 \0 的字符数）
    DWORD fakeLen = (DWORD)wcslen(g_fakeComputerName);
    if (!lpBuffer || !nSize || *nSize < fakeLen + 1) {
        if (nSize) *nSize = fakeLen + 1;
        SetLastError(ERROR_BUFFER_OVERFLOW);
        return FALSE;
    }
    wcscpy(lpBuffer, g_fakeComputerName);
    *nSize = fakeLen;
    SetLastError(ERROR_SUCCESS);
    return TRUE;
}

static BOOL WINAPI HookGetComputerNameExW(COMPUTER_NAME_FORMAT NameType, LPWSTR lpBuffer, LPDWORD nSize) {
    // 仅伪造 ComputerNameDnsHostname 和 ComputerNameNetBIOS（应用读取设备名用的格式）
    if (!g_hookEnabled || !g_fakeComputerName[0] ||
        (NameType != ComputerNameDnsHostname && NameType != ComputerNameNetBIOS)) {
        return OriginalGetComputerNameExW(NameType, lpBuffer, nSize);
    }
    DWORD fakeLen = (DWORD)wcslen(g_fakeComputerName);
    if (!lpBuffer || !nSize || *nSize < fakeLen + 1) {
        if (nSize) *nSize = fakeLen + 1;
        SetLastError(ERROR_BUFFER_OVERFLOW);
        return FALSE;
    }
    wcscpy(lpBuffer, g_fakeComputerName);
    *nSize = fakeLen;
    SetLastError(ERROR_SUCCESS);
    return TRUE;
}

// ==================== SMBIOS device identity isolation ====================
// Aha's native device service calls GetSystemFirmwareTable("RSMB") and uses
// the SMBIOS system UUID as part of its local device identity. Return the
// real table shape but replace only the type-1 system UUID for this instance.
static UINT (WINAPI *OriginalGetSystemFirmwareTable)(DWORD, DWORD, PVOID, UINT) = NULL;

static void PatchSmbiosSystemUuid(PBYTE buffer, UINT size) {
    if (!g_hookEnabled || !g_hasFakeSmbiosUuid || !buffer || size < 8) return;

    DWORD tableLength = 0;
    memcpy(&tableLength, buffer + 4, sizeof(tableLength));
    UINT tableEnd = 8 + tableLength;
    if (tableEnd > size || tableEnd < 8) tableEnd = size;

    PBYTE current = buffer + 8;
    while (current + 4 <= buffer + tableEnd) {
        BYTE type = current[0];
        BYTE formattedLength = current[1];
        if (formattedLength < 4 || current + formattedLength > buffer + tableEnd) break;

        // SMBIOS type 1 (System Information): UUID is at formatted offset 8.
        if (type == 1 && formattedLength >= 24) {
            memcpy(current + 8, g_fakeSmbiosUuid, sizeof(g_fakeSmbiosUuid));
            HookLog("Patched SMBIOS system UUID for isolated instance");
            return;
        }

        // Skip the formatted area and the following string-set, ending at the
        // double NUL required by the SMBIOS structure format.
        current += formattedLength;
        while (current + 1 < buffer + tableEnd && (current[0] != 0 || current[1] != 0)) {
            current++;
        }
        if (current + 1 >= buffer + tableEnd) break;
        current += 2;
    }
}

static UINT WINAPI HookGetSystemFirmwareTable(
    DWORD FirmwareTableProviderSignature,
    DWORD FirmwareTableID,
    PVOID pFirmwareTableBuffer,
    UINT BufferSize)
{
    UINT result = OriginalGetSystemFirmwareTable(
        FirmwareTableProviderSignature,
        FirmwareTableID,
        pFirmwareTableBuffer,
        BufferSize);
    if (FirmwareTableProviderSignature == 'RSMB') {
        HookLog("GetSystemFirmwareTable(RSMB): result=%u buffer=%s", result, pFirmwareTableBuffer ? "yes" : "no");
        if (result > 8 && pFirmwareTableBuffer) {
            PatchSmbiosSystemUuid((PBYTE)pFirmwareTableBuffer, result);
        }
    }
    return result;
}

/** 检测 OBJECT_ATTRIBUTES 路径是否指向 Cryptography 键（不重定向，仅检测） */
static BOOL IsCryptographyKeyPath(POBJECT_ATTRIBUTES oa) {
    if (!g_hookEnabled || !g_fakeMachineGuid[0] || !oa || !oa->ObjectName
        || !oa->ObjectName->Buffer || oa->ObjectName->Length == 0) {
        return FALSE;
    }
    PUNICODE_STRING origName = oa->ObjectName;
    PWSTR origBuf = origName->Buffer;
    USHORT origLen = origName->Length / sizeof(WCHAR);

    // 查找最后一个 '\'
    int lastSlash = -1;
    for (int i = origLen - 1; i >= 0; i--) {
        if (origBuf[i] == L'\\') { lastSlash = i; break; }
    }
    PWSTR lastComponent = origBuf + (lastSlash + 1);
    size_t lastCompLen = origLen - (lastSlash + 1);

    // 检查最后一段是否是 "Cryptography"（12 字符）
    if (lastCompLen != 12) return FALSE;
    if (_wcsnicmp(lastComponent, L"Cryptography", 12) != 0) return FALSE;

    // 确保路径包含 \Microsoft\（排除同名但不同路径的键）
    for (int i = 0; i <= lastSlash - 9; i++) {
        if (_wcsnicmp(origBuf + i, L"\\Microsoft\\", 10) == 0) return TRUE;
    }
    return FALSE;
}

/** 把 Cryptography 键句柄加入追踪表 */
static void TrackCryptoKeyHandle(HANDLE hKey) {
    if (!hKey) return;
    for (int i = 0; i < g_cryptoHandleCount; i++) {
        if (g_cryptoKeyHandles[i] == hKey) return;  // 已存在
    }
    if (g_cryptoHandleCount < MAX_CRYPTO_HANDLES) {
        g_cryptoKeyHandles[g_cryptoHandleCount++] = hKey;
        HookLog("Tracking Cryptography key handle %p", hKey);
    }
}

/** 从追踪表移除句柄（NtClose 时调用） */
static void UntrackCryptoKeyHandle(HANDLE hKey) {
    for (int i = 0; i < g_cryptoHandleCount; i++) {
        if (g_cryptoKeyHandles[i] == hKey) {
            // 用最后一个元素填补空位
            g_cryptoKeyHandles[i] = g_cryptoKeyHandles[g_cryptoHandleCount - 1];
            g_cryptoKeyHandles[g_cryptoHandleCount - 1] = NULL;
            g_cryptoHandleCount--;
            return;
        }
    }
}

/** 检查句柄是否是追踪的 Cryptography 键 */
static BOOL IsCryptoKeyHandle(HANDLE hKey) {
    for (int i = 0; i < g_cryptoHandleCount; i++) {
        if (g_cryptoKeyHandles[i] == hKey) return TRUE;
    }
    return FALSE;
}

// ==================== 文件路径重定向（NtCreateFile/NtOpenFile） ====================
//
// 拦截文件创建/打开操作，将指向宿主用户目录（%APPDATA%, %LOCALAPPDATA%, %USERPROFILE%）
// 的路径重定向到 box 专属目录，防止应用读写宿主设备数据。
//
// 工作原理：
// 1. 读取环境变量 MULTIOPEN_REDIRECT_BASE（box 专属 config 目录）
// 2. 检测文件路径是否指向宿主用户目录
// 3. 如果是，将路径重定向到 box 专属目录下的对应位置
//
// 重定向目标：
// - C:\Users\<user>\AppData\Roaming\...  →  <boxDir>\appdata\Roaming\...
// - C:\Users\<user>\AppData\Local\...     →  <boxDir>\appdata\Local\...
// - C:\Users\<user>\...                   →  <boxDir>\userdata\...
//
// 安全限制：
// - 仅重定向 %APPDATA%, %LOCALAPPDATA%, %USERPROFILE% 下的文件
// - 不重定向系统文件（C:\Windows, C:\Program Files）
// - 不重定向共享目录（g_sharedDir）
// - 不重定向 box 自身目录（防止递归）

// 获取与当前进程关联的 box 根目录（通过环境变量 MULTIOPEN_REDIRECT_BASE 的父目录）
static BOOL GetBoxRootDir(LPWSTR buf, DWORD bufSize) {
    WCHAR redirectBase[MAX_PATH] = { 0 };
    DWORD len = GetEnvironmentVariableW(L"MULTIOPEN_REDIRECT_BASE", redirectBase, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return FALSE;
    // redirectBase 是 <workDir>\config，box 根目录是 <workDir>
    WCHAR* lastSlash = wcsrchr(redirectBase, L'\\');
    if (!lastSlash) return FALSE;
    *lastSlash = L'\0';  // 去掉 \config，得到 workDir
    wcsncpy(buf, redirectBase, bufSize - 1);
    buf[bufSize - 1] = L'\0';
    return TRUE;
}

// 检查路径是否在宿主用户目录下，如果是则重定向到 box 专属目录
// 返回 TRUE 表示已重定向（state 已填充），FALSE 表示无需重定向
typedef struct {
    UNICODE_STRING originalObjectName;
    PUNICODE_STRING pObjectName;
    PWSTR newBuffer;
} NameRewriteState;

static BOOL RewriteFilePath(POBJECT_ATTRIBUTES oa, NameRewriteState* state) {
    memset(state, 0, sizeof(*state));
    if (!g_hookEnabled || !oa || !oa->ObjectName || !oa->ObjectName->Buffer || oa->ObjectName->Length == 0) {
        return FALSE;
    }

    PUNICODE_STRING origName = oa->ObjectName;
    PWSTR origBuf = origName->Buffer;
    USHORT origLen = origName->Length / sizeof(WCHAR);

    // 获取 box 根目录
    WCHAR boxRoot[MAX_PATH] = { 0 };
    if (!GetBoxRootDir(boxRoot, MAX_PATH)) return FALSE;

    // 如果路径已在 box 目录内，不重定向（防止递归）
    if (_wcsnicmp(origBuf, boxRoot, wcslen(boxRoot)) == 0) return FALSE;

    // 获取宿主用户目录路径
    WCHAR userProfile[MAX_PATH] = { 0 };
    DWORD upLen = GetEnvironmentVariableW(L"USERPROFILE", userProfile, MAX_PATH);
    if (upLen == 0 || upLen >= MAX_PATH) return FALSE;

    // 获取宿主 APPDATA 路径
    WCHAR appData[MAX_PATH] = { 0 };
    DWORD adLen = GetEnvironmentVariableW(L"APPDATA", appData, MAX_PATH);
    if (adLen == 0 || adLen >= MAX_PATH) return FALSE;

    // 获取宿主 LOCALAPPDATA 路径
    WCHAR localAppData[MAX_PATH] = { 0 };
    DWORD laLen = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH);
    if (laLen == 0 || laLen >= MAX_PATH) return FALSE;

    // 检查路径是否在宿主目录下，并构建重定向路径
    WCHAR newPath[MAX_PATH * 2] = { 0 };
    BOOL shouldRedirect = FALSE;

    // 检查 APPDATA（Roaming）
    if (_wcsnicmp(origBuf, appData, adLen) == 0) {
        _snwprintf(newPath, MAX_PATH * 2, L"%s\\appdata\\Roaming%s", boxRoot, origBuf + adLen);
        shouldRedirect = TRUE;
    }
    // 检查 LOCALAPPDATA
    else if (_wcsnicmp(origBuf, localAppData, laLen) == 0) {
        _snwprintf(newPath, MAX_PATH * 2, L"%s\\appdata\\Local%s", boxRoot, origBuf + laLen);
        shouldRedirect = TRUE;
    }
    // 检查 USERPROFILE（但不包括 APPDATA 和 LOCALAPPDATA 子目录，避免重复）
    else if (_wcsnicmp(origBuf, userProfile, upLen) == 0 &&
             _wcsnicmp(origBuf, appData, adLen) != 0 &&
             _wcsnicmp(origBuf, localAppData, laLen) != 0) {
        _snwprintf(newPath, MAX_PATH * 2, L"%s\\userdata%s", boxRoot, origBuf + upLen);
        shouldRedirect = TRUE;
    }

    if (!shouldRedirect) return FALSE;

    // 检查是否在共享目录列表中（不重定向共享目录）
    if (g_sharedDir[0]) {
        size_t sharedLen = wcslen(g_sharedDir);
        if (sharedLen > 0 && _wcsnicmp(origBuf, g_sharedDir, sharedLen) == 0) {
            return FALSE;
        }
    }

    // 构建重定向的 OBJECT_ATTRIBUTES
    state->pObjectName = origName;
    state->originalObjectName = *origName;

    size_t newLen = wcslen(newPath);
    size_t newBytes = (newLen + 1) * sizeof(WCHAR);
    state->newBuffer = (PWSTR)HeapAlloc(GetProcessHeap(), 0, newBytes);
    if (!state->newBuffer) return FALSE;

    wcscpy(state->newBuffer, newPath);

    origName->Buffer = state->newBuffer;
    origName->Length = (USHORT)(newLen * sizeof(WCHAR));
    origName->MaximumLength = (USHORT)(newBytes);

    return TRUE;
}

// ==================== 命名对象重定向（Mutex/Event/Semaphore/Section） ====================

/**
 * 重写 OBJECT_ATTRIBUTES 中的对象名，在名字前加 box 前缀
 * 返回修改后的临时缓冲区，调用方需在调用原始函数后调用 RestoreObjectName 恢复
 *
 * 处理规则：
 * - "Global\name" → "Global\BOX_xxx_name"
 * - "Local\name"  → "Local\BOX_xxx_name"
 * - "name"        → "BOX_xxx_name"
 * - 无名对象不处理
 */
static BOOL RewriteObjectName(POBJECT_ATTRIBUTES oa, NameRewriteState* state) {
    memset(state, 0, sizeof(*state));
    if (!g_hookEnabled || !oa || !oa->ObjectName || !oa->ObjectName->Buffer || oa->ObjectName->Length == 0) {
        return FALSE;
    }

    PUNICODE_STRING origName = oa->ObjectName;
    state->pObjectName = origName;
    state->originalObjectName = *origName;

    // 原始名字
    PWSTR origBuf = origName->Buffer;
    USHORT origLen = origName->Length / sizeof(WCHAR); // 字符数

    // 系统/TSF/输入法对象绝不能加 box 前缀：原生钩子只注入 WorkBuddy 主进程，
    // 渲染进程与 Windows TSF(ctfmon/TextInputHost) 没有被注入；如果主进程把
    // TSF/输入法相关的命名对象改写掉，而渲染进程仍用原始名，跨进程输入法
    // 协调就会失配 → 实例内无法使用/切换中文输入法。这里跳过这些对象，
    // 只改写应用自身的单实例锁等普通命名对象（如 WorkBuddy 的 "workbuddy"）。
    static const WCHAR* const skipSubstrings[] = {
        L"MSCTF", L"CTF", L"Tsf", L"TSF", L"InputMethod", L"IME", L"WER", L"Wer",
        L"ShellExecute", L"Shell_", L"Ole", L"Dwm", L"DWM", L"Crypt", L"Wmi",
        L"Lsass", L"Winlogon", L"Logon", L"Security", L"FontCache", L"UxSms",
        L"SCard", L"Crashpad", L"EventSystem", L"Sens", L"TermSrv", L"RDP",
        L"ConsoleHost", L"DataStore", L"SeDebug", L"SeShutdown", L"SamServer",
    };
    for (int i = 0; i < (int)(sizeof(skipSubstrings) / sizeof(skipSubstrings[0])); i++) {
        if (wcsstr(origBuf, skipSubstrings[i])) {
            return FALSE; // 系统/TSF 对象：不改写
        }
    }

    // 检查 Global\ 或 Local\ 前缀
    const WCHAR* globalPrefix = L"Global\\";
    const WCHAR* localPrefix = L"Local\\";
    int prefixSkip = 0; // 要跳过的命名空间前缀字符数
    size_t nsPrefixLen = 0;

    if (origLen > 7 && _wcsnicmp(origBuf, globalPrefix, 7) == 0) {
        prefixSkip = 7;
        nsPrefixLen = 7;
    } else if (origLen > 6 && _wcsnicmp(origBuf, localPrefix, 6) == 0) {
        prefixSkip = 6;
        nsPrefixLen = 6;
    }

    // 构建新名字：[命名空间前缀] + [box前缀] + [原始名字（去掉命名空间前缀）]
    size_t boxPrefixLen = wcslen(g_boxPrefix);
    size_t newLen = nsPrefixLen + boxPrefixLen + (origLen - prefixSkip);
    size_t newBytes = (newLen + 1) * sizeof(WCHAR);

    state->newBuffer = (PWSTR)HeapAlloc(GetProcessHeap(), 0, newBytes);
    if (!state->newBuffer) return FALSE;

    // 拼接新名字
    PWSTR p = state->newBuffer;
    if (nsPrefixLen > 0) {
        memcpy(p, origBuf, nsPrefixLen * sizeof(WCHAR));
        p += nsPrefixLen;
    }
    memcpy(p, g_boxPrefix, boxPrefixLen * sizeof(WCHAR));
    p += boxPrefixLen;
    memcpy(p, origBuf + prefixSkip, (origLen - prefixSkip) * sizeof(WCHAR));
    p += (origLen - prefixSkip);
    *p = L'\0';

    // 更新 OBJECT_ATTRIBUTES
    origName->Buffer = state->newBuffer;
    origName->Length = (USHORT)(newLen * sizeof(WCHAR));
    origName->MaximumLength = (USHORT)((newLen + 1) * sizeof(WCHAR));

    // This path can run for every named object created by Electron. Do not
    // synchronously write a log line here; that turns normal UI/IME activity
    // into disk I/O and is a major source of instance lag.
    return TRUE;
}

static void RestoreObjectName(NameRewriteState* state) {
    if (state->pObjectName) {
        state->pObjectName->Buffer = state->originalObjectName.Buffer;
        state->pObjectName->Length = state->originalObjectName.Length;
        state->pObjectName->MaximumLength = state->originalObjectName.MaximumLength;
    }
    if (state->newBuffer) {
        HeapFree(GetProcessHeap(), 0, state->newBuffer);
        state->newBuffer = NULL;
    }
}

// ==================== Hook 函数定义 ====================

// 原始函数指针（MinHook 创建后填充）
static PFN_NtCreateMutant    OriginalNtCreateMutant = NULL;
static PFN_NtOpenMutant      OriginalNtOpenMutant = NULL;
static PFN_NtCreateEvent     OriginalNtCreateEvent = NULL;
static PFN_NtOpenEvent       OriginalNtOpenEvent = NULL;
static PFN_NtCreateSemaphore OriginalNtCreateSemaphore = NULL;
static PFN_NtOpenSemaphore   OriginalNtOpenSemaphore = NULL;

// ---- Mutex hook ----

static NTSTATUS NTAPI HookNtCreateMutant(
    PHANDLE MutantHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, BOOLEAN InitialOwner)
{
    NameRewriteState state;
    BOOL rewritten = RewriteObjectName(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtCreateMutant(MutantHandle, DesiredAccess, ObjectAttributes, InitialOwner);
    if (rewritten) RestoreObjectName(&state);
    return status;
}

static NTSTATUS NTAPI HookNtOpenMutant(
    PHANDLE MutantHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes)
{
    NameRewriteState state;
    BOOL rewritten = RewriteObjectName(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtOpenMutant(MutantHandle, DesiredAccess, ObjectAttributes);
    if (rewritten) RestoreObjectName(&state);
    return status;
}

// ---- Event hook ----

static BOOL IsInitializationHandshakeObject(POBJECT_ATTRIBUTES ObjectAttributes) {
    static const WCHAR needle[] = L"WorkBuddyMultiopenInit_";
    if (!ObjectAttributes || !ObjectAttributes->ObjectName
        || !ObjectAttributes->ObjectName->Buffer) return FALSE;

    const USHORT nameChars = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);
    const USHORT needleChars = (USHORT)(ARRAYSIZE(needle) - 1);
    if (nameChars < needleChars) return FALSE;

    for (USHORT i = 0; i <= nameChars - needleChars; ++i) {
        if (memcmp(ObjectAttributes->ObjectName->Buffer + i,
                   needle, needleChars * sizeof(WCHAR)) == 0) {
            return TRUE;
        }
    }
    return FALSE;
}

static NTSTATUS NTAPI HookNtCreateEvent(
    PHANDLE EventHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, int EventType, BOOLEAN InitialState)
{
    // The injector and the loader-lock-safe initialization worker must rendezvous
    // on the same cross-process event. It is infrastructure, not application
    // singleton state, so it must never receive the per-instance object prefix.
    if (IsInitializationHandshakeObject(ObjectAttributes)) {
        return OriginalNtCreateEvent(EventHandle, DesiredAccess, ObjectAttributes, EventType, InitialState);
    }
    NameRewriteState state;
    BOOL rewritten = RewriteObjectName(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtCreateEvent(EventHandle, DesiredAccess, ObjectAttributes, EventType, InitialState);
    if (rewritten) RestoreObjectName(&state);
    return status;
}

static NTSTATUS NTAPI HookNtOpenEvent(
    PHANDLE EventHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes)
{
    if (IsInitializationHandshakeObject(ObjectAttributes)) {
        return OriginalNtOpenEvent(EventHandle, DesiredAccess, ObjectAttributes);
    }
    NameRewriteState state;
    BOOL rewritten = RewriteObjectName(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtOpenEvent(EventHandle, DesiredAccess, ObjectAttributes);
    if (rewritten) RestoreObjectName(&state);
    return status;
}

// ---- Semaphore hook ----

static NTSTATUS NTAPI HookNtCreateSemaphore(
    PHANDLE SemaphoreHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, LONG InitialCount, LONG MaximumCount)
{
    NameRewriteState state;
    BOOL rewritten = RewriteObjectName(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtCreateSemaphore(SemaphoreHandle, DesiredAccess, ObjectAttributes, InitialCount, MaximumCount);
    if (rewritten) RestoreObjectName(&state);
    return status;
}

static NTSTATUS NTAPI HookNtOpenSemaphore(
    PHANDLE SemaphoreHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes)
{
    NameRewriteState state;
    BOOL rewritten = RewriteObjectName(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtOpenSemaphore(SemaphoreHandle, DesiredAccess, ObjectAttributes);
    if (rewritten) RestoreObjectName(&state);
    return status;
}

// ---- 注册表隔离 hook ----
//
// Hook NtCreateKey/NtOpenKey：重定向两类注册表键到 box 专属键：
// 1. TimeZoneInformation → box 专属时区键（隔离 GetTimeZoneInformation API）
// 2. Cryptography → box 专属 Cryptography 子键（隔离 MachineGuid 设备标识）

static PFN_NtCreateKey OriginalNtCreateKey = NULL;
static PFN_NtOpenKey   OriginalNtOpenKey = NULL;

// 检查对象名是否以 \TimeZoneInformation 结尾（或就是 TimeZoneInformation），
// 如果是则重写为 \<boxPrefix>TimeZoneInformation
static BOOL RewriteTimeZoneKeyPath(POBJECT_ATTRIBUTES oa, NameRewriteState* state) {
    memset(state, 0, sizeof(*state));
    if (!g_hookEnabled || !g_tzKeyPath[0] || !oa || !oa->ObjectName || !oa->ObjectName->Buffer || oa->ObjectName->Length == 0) {
        return FALSE;
    }

    PUNICODE_STRING origName = oa->ObjectName;
    PWSTR origBuf = origName->Buffer;
    USHORT origLen = origName->Length / sizeof(WCHAR); // 字符数

    // 查找最后一个 '\'
    int lastSlash = -1;
    for (int i = origLen - 1; i >= 0; i--) {
        if (origBuf[i] == L'\\') {
            lastSlash = i;
            break;
        }
    }

    // 最后一个路径组件
    PWSTR lastComponent = origBuf + (lastSlash + 1);
    size_t lastCompLen = origLen - (lastSlash + 1);

    // 检查是否是 TimeZoneInformation（不区分大小写）
    if (lastCompLen != 18) return FALSE; // wcslen(L"TimeZoneInformation") = 18
    if (_wcsnicmp(lastComponent, L"TimeZoneInformation", 18) != 0) return FALSE;

    // 构建新名字：[前缀路径\] + boxPrefix + TimeZoneInformation
    state->pObjectName = origName;
    state->originalObjectName = *origName;

    size_t prefixLen = (lastSlash >= 0) ? (size_t)(lastSlash + 1) : 0;
    size_t boxPrefixLen = wcslen(g_boxPrefix);
    size_t newLen = prefixLen + boxPrefixLen + 18; // boxPrefix + "TimeZoneInformation"
    size_t newBytes = (newLen + 1) * sizeof(WCHAR);

    state->newBuffer = (PWSTR)HeapAlloc(GetProcessHeap(), 0, newBytes);
    if (!state->newBuffer) return FALSE;

    PWSTR p = state->newBuffer;
    if (prefixLen > 0) {
        memcpy(p, origBuf, prefixLen * sizeof(WCHAR));
        p += prefixLen;
    }
    memcpy(p, g_boxPrefix, boxPrefixLen * sizeof(WCHAR));
    p += boxPrefixLen;
    memcpy(p, L"TimeZoneInformation", 18 * sizeof(WCHAR));
    p += 18;
    *p = L'\0';

    origName->Buffer = state->newBuffer;
    origName->Length = (USHORT)(newLen * sizeof(WCHAR));
    origName->MaximumLength = (USHORT)((newLen + 1) * sizeof(WCHAR));

    HookLog("Rewrote timezone registry key path");
    return TRUE;
}

// 注意：Cryptography 键不再通过路径重写隔离（旧方案依赖写 HKLM，非管理员权限失败）。
// MachineGuid 隔离改为：NtOpenKey/NtCreateKey 返回真实句柄 + 追踪句柄 + NtQueryValueKey 返回伪造值。
// 详见上方的 IsCryptographyKeyPath / TrackCryptoKeyHandle / HookNtQueryValueKey。

// 统一注册表路径重写：仅处理时区重定向（MachineGuid 已改为句柄追踪方案）
static BOOL RewriteRegistryKeyPath(POBJECT_ATTRIBUTES oa, NameRewriteState* state) {
    return RewriteTimeZoneKeyPath(oa, state);
}

static NTSTATUS NTAPI HookNtCreateKey(
    PHANDLE KeyHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, ULONG TitleIndex,
    PVOID Class, ULONG CreateOptions, PULONG Disposition)
{
    // 检测是否打开/创建 Cryptography 键（不重定向，仅标记用于后续 NtQueryValueKey 追踪）
    BOOL isCrypto = IsCryptographyKeyPath(ObjectAttributes);

    NameRewriteState state;
    BOOL rewritten = RewriteRegistryKeyPath(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtCreateKey(KeyHandle, DesiredAccess, ObjectAttributes, TitleIndex, Class, CreateOptions, Disposition);
    if (rewritten) RestoreObjectName(&state);

    // 成功打开 Cryptography 键 → 追踪句柄，供 NtQueryValueKey 拦截 MachineGuid 查询
    if (NT_SUCCESS(status) && isCrypto && KeyHandle && *KeyHandle) {
        TrackCryptoKeyHandle(*KeyHandle);
    }
    return status;
}

static NTSTATUS NTAPI HookNtOpenKey(
    PHANDLE KeyHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes)
{
    // 检测是否打开 Cryptography 键（不重定向，仅标记用于后续 NtQueryValueKey 追踪）
    BOOL isCrypto = IsCryptographyKeyPath(ObjectAttributes);

    NameRewriteState state;
    BOOL rewritten = RewriteRegistryKeyPath(ObjectAttributes, &state);
    NTSTATUS status = OriginalNtOpenKey(KeyHandle, DesiredAccess, ObjectAttributes);
    if (rewritten) RestoreObjectName(&state);

    // 成功打开 Cryptography 键 → 追踪句柄，供 NtQueryValueKey 拦截 MachineGuid 查询
    if (NT_SUCCESS(status) && isCrypto && KeyHandle && *KeyHandle) {
        TrackCryptoKeyHandle(*KeyHandle);
    }
    return status;
}

// ==================== NtQueryValueKey hook（MachineGuid 值伪造） ====================
//
// 拦截注册表值查询：当应用查询 Cryptography 键的 MachineGuid 值时，
// 返回 box 专属的伪造 GUID，而不是真实的系统 MachineGuid。
// RegQueryValueExW 内部调用 NtQueryValueKey，因此本 hook 覆盖所有读取路径。
//
// 兼容三种 KeyValueInformationClass：
// - KeyValuePartialInformation：只有 Type + Data（RegQueryValueExW 最常用）
// - KeyValueFullInformation：Name + Type + Data
// - KeyValueBasicInformation：Name + Type（无 Data，仅返回类型即可）

static PFN_NtQueryValueKey OriginalNtQueryValueKey = NULL;
static PFN_NtClose         OriginalNtClose = NULL;

static NTSTATUS NTAPI HookNtQueryValueKey(
    HANDLE KeyHandle,
    PUNICODE_STRING ValueName,
    KEY_VALUE_INFORMATION_CLASS KeyValueInformationClass,
    PVOID KeyValueInformation,
    ULONG Length,
    PULONG ResultLength)
{
    // 先调用原函数（保持正常行为，仅对 Cryptography 键的 MachineGuid 做替换）
    NTSTATUS status = OriginalNtQueryValueKey(KeyHandle, ValueName, KeyValueInformationClass,
                                              KeyValueInformation, Length, ResultLength);

    // 仅当：启用了 MachineGuid 伪造 + 句柄是 Cryptography 键 + 查询的值名是 MachineGuid
    if (!NT_SUCCESS(status) || !g_fakeMachineGuid[0] || !IsCryptoKeyHandle(KeyHandle)) {
        return status;
    }
    if (!ValueName || !ValueName->Buffer || ValueName->Length == 0) {
        return status;
    }
    // ValueName->Length 是字节数，MachineGuid 是 12 个宽字符 = 24 字节
    if (ValueName->Length != 24 || _wcsnicmp(ValueName->Buffer, L"MachineGuid", 11) != 0) {
        return status;
    }

    // MachineGuid 是 REG_SZ 类型，值为宽字符字符串（含末尾 \0）
    // 格式：XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX（36 字符 + \0 = 37 个 WCHAR = 74 字节）
    size_t guidChars = wcslen(g_fakeMachineGuid);       // 不含 \0
    size_t dataBytes = (guidChars + 1) * sizeof(WCHAR); // 含 \0

    HookLog("Spoofing MachineGuid value (handle=%p, guid=%S)", KeyHandle, g_fakeMachineGuid);

    switch (KeyValueInformationClass) {
    case KeyValuePartialInformation:
    case KeyValuePartialInformationAlign64: {
        PKEY_VALUE_PARTIAL_INFORMATION info = (PKEY_VALUE_PARTIAL_INFORMATION)KeyValueInformation;
        ULONG needed = sizeof(ULONG) * 3 + (ULONG)dataBytes;  // TitleIndex + Type + DataLength + Data
        if (ResultLength) *ResultLength = needed;
        if (Length < needed) return STATUS_BUFFER_OVERFLOW;
        info->TitleIndex = 0;
        info->Type = REG_SZ;
        info->DataLength = (ULONG)dataBytes;
        memcpy(info->Data, g_fakeMachineGuid, dataBytes);
        return STATUS_SUCCESS;
    }
    case KeyValueFullInformation:
    case KeyValueFullInformationAlign64: {
        PKEY_VALUE_FULL_INFORMATION info = (PKEY_VALUE_FULL_INFORMATION)KeyValueInformation;
        ULONG nameBytes = 24;  // "MachineGuid" 12 WCHAR * 2
        ULONG needed = sizeof(ULONG) * 5 + nameBytes + (ULONG)dataBytes;  // 5 个 ULONG + Name + Data
        if (ResultLength) *ResultLength = needed;
        if (Length < needed) return STATUS_BUFFER_OVERFLOW;
        info->TitleIndex = 0;
        info->Type = REG_SZ;
        info->DataOffset = sizeof(ULONG) * 5 + nameBytes;  // Data 紧跟在 Name 后
        info->DataLength = (ULONG)dataBytes;
        info->NameLength = nameBytes;
        memcpy(info->Name, L"MachineGuid", nameBytes);
        memcpy((PUCHAR)info + info->DataOffset, g_fakeMachineGuid, dataBytes);
        return STATUS_SUCCESS;
    }
    case KeyValueBasicInformation: {
        PKEY_VALUE_BASIC_INFORMATION info = (PKEY_VALUE_BASIC_INFORMATION)KeyValueInformation;
        ULONG nameBytes = 24;
        ULONG needed = sizeof(ULONG) * 3 + nameBytes;  // TitleIndex + Type + NameLength + Name
        if (ResultLength) *ResultLength = needed;
        if (Length < needed) return STATUS_BUFFER_OVERFLOW;
        info->TitleIndex = 0;
        info->Type = REG_SZ;
        info->NameLength = nameBytes;
        memcpy(info->Name, L"MachineGuid", nameBytes);
        return STATUS_SUCCESS;
    }
    default:
        return status;  // 未知类型，不处理
    }
}

// ==================== NtClose hook（清理句柄追踪表） ====================
//
// 应用关闭 Cryptography 键句柄时，从追踪表移除，避免：
// 1. 追踪表填满（上限 64）
// 2. 句柄值被 OS 复用给其他键，导致 NtQueryValueKey 误判

static NTSTATUS NTAPI HookNtClose(HANDLE Handle) {
    if (Handle && IsCryptoKeyHandle(Handle)) {
        UntrackCryptoKeyHandle(Handle);
    }
    return OriginalNtClose(Handle);
}

// ==================== ShellExecute hook（浏览器重定向到实例环境） ====================
//
// 问题：实例内应用点击外部链接时，ShellExecute 会启动系统默认浏览器，
//       新进程不在实例环境中（不继承 hook DLL、不使用实例的 user-data-dir/代理）。
//
// 方案：hook ShellExecuteW / ShellExecuteExW，当检测到打开 http/https URL 时，
//       改为用实例自己的应用路径启动，并附加 --user-data-dir 和 --proxy-server 参数，
//       使弹出的"浏览器"实际上是实例内的应用本身（共享隔离环境）。
//
// 依赖环境变量（由 engine.ts 启动时注入）：
//   MULTIOPEN_APP_PATH        实例应用完整路径
//   MULTIOPEN_USER_DATA_DIR   实例隔离的用户数据目录
//   MULTIOPEN_PROXY_SERVER    实例代理 URL（可选）

// 判断是否是 http/https URL
static BOOL IsHttpUrl(LPCWSTR lpFile) {
    if (!lpFile) return FALSE;
    if (_wcsnicmp(lpFile, L"http://", 7) == 0) return TRUE;
    if (_wcsnicmp(lpFile, L"https://", 8) == 0) return TRUE;
    return FALSE;
}

// 获取 URL 重定向目标路径（浏览器优先，回退到实例应用路径）
// 优先返回 g_browserPath（Chrome/Edge），如果未设置则回退到 MULTIOPEN_APP_PATH
static BOOL GetRedirectTarget(LPWSTR buf, DWORD bufSize) {
    if (g_browserPath[0]) {
        wcsncpy(buf, g_browserPath, bufSize - 1);
        buf[bufSize - 1] = L'\0';
        return TRUE;
    }
    // 回退：用实例应用路径（当应用本身是浏览器时有效）
    DWORD len = GetEnvironmentVariableW(L"MULTIOPEN_APP_PATH", buf, bufSize);
    return (len > 0 && len < bufSize);
}

// 获取 URL 重定向用的 user-data-dir（浏览器独立目录优先，回退到实例 config 目录）
static BOOL GetRedirectUserDataDir(LPWSTR buf, DWORD bufSize) {
    if (g_browserUserDataDir[0]) {
        wcsncpy(buf, g_browserUserDataDir, bufSize - 1);
        buf[bufSize - 1] = L'\0';
        return TRUE;
    }
    DWORD len = GetEnvironmentVariableW(L"MULTIOPEN_USER_DATA_DIR", buf, bufSize);
    return (len > 0 && len < bufSize);
}

// 判断进程路径是否已经是重定向目标（避免无限递归）
static BOOL IsAlreadyRedirectTarget(LPCWSTR path) {
    if (!path) return FALSE;
    if (g_browserPath[0] && _wcsicmp(path, g_browserPath) == 0) return TRUE;
    if (g_appPath[0] && _wcsicmp(path, g_appPath) == 0) return TRUE;
    return FALSE;
}

// 构建重定向参数字符串：--user-data-dir="xxx" [--proxy-server="xxx"] [--user-agent="xxx"] [--lang="xxx"] URL
// 返回新分配的缓冲区（调用方需 HeapFree），失败返回 NULL
static LPWSTR BuildRedirectParams(LPCWSTR url) {
    WCHAR userDataDir[MAX_PATH] = { 0 };
    WCHAR proxyServer[256] = { 0 };
    WCHAR userAgent[512] = { 0 };
    WCHAR lang[32] = { 0 };

    GetRedirectUserDataDir(userDataDir, MAX_PATH);
    GetEnvironmentVariableW(L"MULTIOPEN_PROXY_SERVER", proxyServer, 256);
    GetEnvironmentVariableW(L"MULTIOPEN_USER_AGENT", userAgent, 512);
    GetEnvironmentVariableW(L"MULTIOPEN_LANG", lang, 32);

    // 估算缓冲区大小
    size_t totalLen = 0;
    if (userDataDir[0]) totalLen += 32 + wcslen(userDataDir);       // --user-data-dir="..."
    totalLen += 512;                                                // 所有禁用参数（含扩展的 disable-features 列表）
    if (proxyServer[0]) totalLen += 32 + wcslen(proxyServer);       // --proxy-server="..."
    if (userAgent[0])   totalLen += 32 + wcslen(userAgent);         // --user-agent="..."
    if (lang[0])        totalLen += 32 + wcslen(lang) * 2;          // --lang="..." --accept-lang="..."
    totalLen += wcslen(url) + 6;                                    //  "URL"（含引号和空格）

    LPWSTR buf = (LPWSTR)HeapAlloc(GetProcessHeap(), 0, (totalLen + 1) * sizeof(WCHAR));
    if (!buf) return NULL;

    LPWSTR p = buf;
    size_t remaining = totalLen;
    if (userDataDir[0]) {
        int n = _snwprintf(p, remaining, L"--user-data-dir=\"%s\"", userDataDir);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= n;
    }
    // 独立会话启动参数 + 禁用 QUIC（UDP 不走 HTTP 代理，会导致页面加载超时转圈）
    {
        if (p != buf) { *p++ = L' '; remaining--; }
        int n = _snwprintf(p, remaining,
            L"--profile-directory=Default --no-first-run --no-default-browser-check"
            L" --disable-sync --disable-background-networking --disable-quic"
            L" --disable-component-update --disable-domain-reliability"
            L" --disable-extensions --disable-plugins-discovery"
            L" --disable-features=RestoreOnStartup,BackgroundMode,ChromeRuntimeLimits"
            L" --disable-background-downloads --disable-sync --disable-default-apps");
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= n;
    }
    if (proxyServer[0]) {
        if (p != buf) { *p++ = L' '; remaining--; }
        int n = _snwprintf(p, remaining, L" --proxy-server=\"%s\"", proxyServer);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= n;
    }
    if (userAgent[0]) {
        if (p != buf) { *p++ = L' '; remaining--; }
        int n = _snwprintf(p, remaining, L"--user-agent=\"%s\"", userAgent);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= n;
    }
    if (lang[0]) {
        if (p != buf) { *p++ = L' '; remaining--; }
        int n = _snwprintf(p, remaining, L"--lang=\"%s\" --accept-lang=\"%s\"", lang, lang);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= n;
    }
    if (p != buf) { *p++ = L' '; }
    *p++ = L'"';
    wcscpy(p, url);
    p += wcslen(url);
    *p++ = L'"';
    *p = L'\0';

    return buf;
}

// 原始函数指针
static HINSTANCE (WINAPI *OriginalShellExecuteW)(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT) = NULL;
static BOOL (WINAPI *OriginalShellExecuteExW)(LPSHELLEXECUTEINFOW) = NULL;
// ExtractUrlFromCommandLine 定义在后面的 CreateProcess hook 区域；ShellExecute
// 也需要处理“浏览器程序 + URL 参数”的常见调用形式。
static LPWSTR ExtractUrlFromCommandLine(LPCWSTR cmdLine);

static HINSTANCE WINAPI HookShellExecuteW(
    HWND hwnd, LPCWSTR lpOperation, LPCWSTR lpFile,
    LPCWSTR lpParameters, LPCWSTR lpDirectory, INT nShowCmd)
{
    // 常见调用形式是 lpFile=浏览器程序，lpParameters=URL。原先只检查
    // lpFile，导致该路径绕过实例浏览器重定向，退回系统默认浏览器。
    if (g_hookEnabled && lpParameters && !IsHttpUrl(lpFile)) {
        LPWSTR url = ExtractUrlFromCommandLine(lpParameters);
        if (url) {
            WCHAR redirectPath[MAX_PATH] = { 0 };
            if (GetRedirectTarget(redirectPath, MAX_PATH)) {
                LPWSTR redirectParams = BuildRedirectParams(url);
                if (redirectParams) {
                    HookLog("Redirect ShellExecuteW parameter URL to browser: %S", redirectPath);
                    HINSTANCE ret = OriginalShellExecuteW(hwnd, L"open", redirectPath, redirectParams, lpDirectory, nShowCmd);
                    HeapFree(GetProcessHeap(), 0, redirectParams);
                    HeapFree(GetProcessHeap(), 0, url);
                    return ret;
                }
            }
            HeapFree(GetProcessHeap(), 0, url);
        }
    }

    if (g_hookEnabled && IsHttpUrl(lpFile)) {
        WCHAR redirectPath[MAX_PATH] = { 0 };
        if (GetRedirectTarget(redirectPath, MAX_PATH)) {
            LPWSTR redirectParams = BuildRedirectParams(lpFile);
            if (redirectParams) {
                HookLog("Redirect ShellExecuteW to browser: %S", redirectPath);
                HINSTANCE ret = OriginalShellExecuteW(hwnd, L"open", redirectPath, redirectParams, lpDirectory, nShowCmd);
                HeapFree(GetProcessHeap(), 0, redirectParams);
                return ret;
            }
        }
    }
    return OriginalShellExecuteW(hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd);
}

static BOOL WINAPI HookShellExecuteExW(LPSHELLEXECUTEINFOW lpExecInfo) {
    // 与 ShellExecuteW 相同，覆盖 lpFile 是浏览器程序、lpParameters 才是 URL 的路径。
    if (g_hookEnabled && lpExecInfo && lpExecInfo->lpParameters &&
        !IsHttpUrl(lpExecInfo->lpFile)) {
        LPWSTR url = ExtractUrlFromCommandLine(lpExecInfo->lpParameters);
        if (url) {
            WCHAR redirectPath[MAX_PATH] = { 0 };
            if (GetRedirectTarget(redirectPath, MAX_PATH)) {
                LPWSTR redirectParams = BuildRedirectParams(url);
                if (redirectParams) {
                    HookLog("Redirect ShellExecuteExW parameter URL to browser: %S", redirectPath);
                    LPCWSTR origVerb = lpExecInfo->lpVerb;
                    LPCWSTR origFile = lpExecInfo->lpFile;
                    LPCWSTR origParams = lpExecInfo->lpParameters;

                    lpExecInfo->lpVerb = L"open";
                    lpExecInfo->lpFile = redirectPath;
                    lpExecInfo->lpParameters = redirectParams;
                    BOOL ret = OriginalShellExecuteExW(lpExecInfo);
                    lpExecInfo->lpVerb = origVerb;
                    lpExecInfo->lpFile = origFile;
                    lpExecInfo->lpParameters = origParams;

                    HeapFree(GetProcessHeap(), 0, redirectParams);
                    HeapFree(GetProcessHeap(), 0, url);
                    return ret;
                }
            }
            HeapFree(GetProcessHeap(), 0, url);
        }
    }

    if (g_hookEnabled && lpExecInfo && IsHttpUrl(lpExecInfo->lpFile)) {
        WCHAR redirectPath[MAX_PATH] = { 0 };
        if (GetRedirectTarget(redirectPath, MAX_PATH)) {
            LPWSTR redirectParams = BuildRedirectParams(lpExecInfo->lpFile);
            if (redirectParams) {
                HookLog("Redirect ShellExecuteExW to browser: %S", redirectPath);
                // 保存原始字段，调用后恢复（调用方可能复用结构体）
                LPCWSTR origVerb = lpExecInfo->lpVerb;
                LPCWSTR origFile = lpExecInfo->lpFile;
                LPCWSTR origParams = lpExecInfo->lpParameters;

                lpExecInfo->lpVerb = L"open";
                lpExecInfo->lpFile = redirectPath;
                lpExecInfo->lpParameters = redirectParams;

                BOOL ret = OriginalShellExecuteExW(lpExecInfo);

                lpExecInfo->lpVerb = origVerb;
                lpExecInfo->lpFile = origFile;
                lpExecInfo->lpParameters = origParams;

                HeapFree(GetProcessHeap(), 0, redirectParams);
                return ret;
            }
        }
    }
    return OriginalShellExecuteExW(lpExecInfo);
}

// ==================== CreateProcessW hook（浏览器重定向底层拦截） ====================
//
// ShellExecute hook 可能失效的原因：
//   很多应用（Electron/Chromium 系）打开外部链接时，不经过 ShellExecute，
//   而是先查询系统默认浏览器路径，再直接调用 CreateProcessW 启动浏览器。
//   此时 ShellExecute hook 不会被触发。
//
// 方案：hook CreateProcessW（所有进程创建的底层入口），检测命令行是否包含
//       独立的 http/https URL 参数，如果是则重定向到实例应用。
//       ShellExecute 内部最终也调用 CreateProcessW，因此本 hook 能覆盖所有场景。

// 从命令行中提取第一个独立的 http/https URL 参数
// 扫描所有参数（不跳过第一个），因为 lpCommandLine 可能只有 URL 而无 exe 路径
// （当 lpApplicationName 单独指定 exe 时，lpCommandLine 可能仅含 URL）
// 可执行文件路径不会以 http:// 或 https:// 开头，故不会误匹配
static LPWSTR ExtractUrlFromCommandLine(LPCWSTR cmdLine) {
    if (!cmdLine || !*cmdLine) return NULL;

    LPCWSTR p = cmdLine;

    // 遍历所有参数
    while (*p) {
        while (*p == L' ' || *p == L'\t') p++;
        if (!*p) break;

        LPCWSTR argStart;
        size_t argLen;

        if (*p == L'"') {
            p++;
            argStart = p;
            while (*p && *p != L'"') p++;
            argLen = (size_t)(p - argStart);
            if (*p == L'"') p++;
        } else {
            argStart = p;
            while (*p && *p != L' ' && *p != L'\t') p++;
            argLen = (size_t)(p - argStart);
        }

        if (argLen >= 7) {
            if (_wcsnicmp(argStart, L"http://", 7) == 0 || _wcsnicmp(argStart, L"https://", 8) == 0) {
                LPWSTR url = (LPWSTR)HeapAlloc(GetProcessHeap(), 0, (argLen + 1) * sizeof(WCHAR));
                if (url) {
                    wcsncpy(url, argStart, argLen);
                    url[argLen] = L'\0';
                    return url;
                }
            }
        }
    }

    return NULL;
}

// 构建重定向命令行：使用实例专属 Chromium 会话。
// 这些参数很重要：即使浏览器本身已经在运行，也不能把 URL 合并到宿主的
// 默认 Profile/同步会话中，否则实例会看到宿主账号、Cookie 和扩展数据。
static LPWSTR BuildRedirectCommandLine(LPCWSTR redirectPath, LPCWSTR url) {
    WCHAR userDataDir[MAX_PATH] = { 0 };
    WCHAR proxyServer[256] = { 0 };
    WCHAR userAgent[512] = { 0 };
    WCHAR lang[32] = { 0 };
    GetRedirectUserDataDir(userDataDir, MAX_PATH);
    GetEnvironmentVariableW(L"MULTIOPEN_PROXY_SERVER", proxyServer, 256);
    GetEnvironmentVariableW(L"MULTIOPEN_USER_AGENT", userAgent, 512);
    GetEnvironmentVariableW(L"MULTIOPEN_LANG", lang, 32);

    // 计算缓冲区大小
    size_t len = wcslen(redirectPath) + 3;                     // "redirectPath"
    if (userDataDir[0]) len += 30 + wcslen(userDataDir);       //  --user-data-dir="..."
    len += 512;                                                //  独立会话启动参数（含扩展的 disable-features）
    if (proxyServer[0]) len += 32 + wcslen(proxyServer);       //  --proxy-server="..."
    if (userAgent[0])   len += 30 + wcslen(userAgent);         //  --user-agent="..."
    if (lang[0])        len += 30 + wcslen(lang) * 2;          //  --lang="..." --accept-lang="..."
    len += wcslen(url) + 4;                                    //  "URL"（加引号防止 & 等特殊字符导致解析错误）

    LPWSTR buf = (LPWSTR)HeapAlloc(GetProcessHeap(), 0, (len + 1) * sizeof(WCHAR));
    if (!buf) return NULL;

    int n;
    LPWSTR p = buf;
    size_t remaining = len;

    n = _snwprintf(p, remaining, L"\"%s\"", redirectPath);
    if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
    p += n; remaining -= (size_t)n;

    if (userDataDir[0]) {
        n = _snwprintf(p, remaining, L" --user-data-dir=\"%s\"", userDataDir);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= (size_t)n;
    }
    // 不使用宿主 Profile、同步账号或后台恢复状态；Profile 名固定在实例目录内。
    // --disable-quic：QUIC 使用 UDP，HTTP 代理只代理 TCP，QUIC 请求绕过代理直连失败后
    // 需等待超时才回退 TCP，导致页面加载长时间转圈。禁用后直接走 TCP → 代理。
    // Chromium 默认让 localhost/127.0.0.1 直连。不要追加 <-loopback>：
    // 该特殊规则恰好会取消默认旁路，使 OAuth 本地回调错误地经过代理。
    // --disable-component-update --disable-domain-reliability：禁止后台组件更新和上报。
    // --disable-extensions：首次启动时 Edge 会扫描/加载扩展，拖慢首次页面加载。
    n = _snwprintf(p, remaining,
        L" --profile-directory=Default --no-first-run --no-default-browser-check"
        L" --disable-sync --disable-background-networking --disable-quic"
        L" --disable-component-update --disable-domain-reliability"
        L" --disable-extensions --disable-plugins-discovery"
        L" --disable-features=RestoreOnStartup,BackgroundMode,ChromeRuntimeLimits"
        L" --disable-background-downloads --disable-default-apps");
    if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
    p += n; remaining -= (size_t)n;
    if (proxyServer[0]) {
        n = _snwprintf(p, remaining, L" --proxy-server=\"%s\"", proxyServer);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= (size_t)n;
    }
    if (userAgent[0]) {
        n = _snwprintf(p, remaining, L" --user-agent=\"%s\"", userAgent);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= (size_t)n;
    }
    if (lang[0]) {
        n = _snwprintf(p, remaining, L" --lang=\"%s\" --accept-lang=\"%s\"", lang, lang);
        if (n < 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
        p += n; remaining -= (size_t)n;
    }
    _snwprintf(p, remaining, L" \"%s\"", url);

    return buf;
}

// 原始 CreateProcessW 函数指针
static BOOL (WINAPI *OriginalCreateProcessW)(
    LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
    BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION
) = NULL;

static BOOL WINAPI HookCreateProcessW(
    LPCWSTR lpApplicationName,
    LPWSTR lpCommandLine,
    LPSECURITY_ATTRIBUTES lpProcessAttributes,
    LPSECURITY_ATTRIBUTES lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCWSTR lpCurrentDirectory,
    LPSTARTUPINFOW lpStartupInfo,
    LPPROCESS_INFORMATION lpProcessInformation)
{
    if (g_hookEnabled && lpCommandLine) {
        // 快速预检：命令行是否包含 "http"（避免对不含 URL 的 CreateProcess 调用做完整解析）
        if (wcsstr(lpCommandLine, L"http")) {
            LPWSTR url = ExtractUrlFromCommandLine(lpCommandLine);
            if (url) {
                WCHAR redirectPath[MAX_PATH] = { 0 };
                if (GetRedirectTarget(redirectPath, MAX_PATH)) {
                    // 如果已经是重定向目标路径，不重复处理（避免无限递归）
                    if (!lpApplicationName || !IsAlreadyRedirectTarget(lpApplicationName)) {
                        LPWSTR newCmdLine = BuildRedirectCommandLine(redirectPath, url);
                        if (newCmdLine) {
                            HookLog("Redirect CreateProcessW to browser: %S user_data_dir=%S", redirectPath, g_browserUserDataDir);
                            BOOL ret = OriginalCreateProcessW(
                                redirectPath, newCmdLine,
                                lpProcessAttributes, lpThreadAttributes,
                                bInheritHandles, dwCreationFlags,
                                lpEnvironment, lpCurrentDirectory,
                                lpStartupInfo, lpProcessInformation
                            );
                            HeapFree(GetProcessHeap(), 0, newCmdLine);
                            HeapFree(GetProcessHeap(), 0, url);
                            return ret;
                        }
                    }
                }
                HeapFree(GetProcessHeap(), 0, url);
            }
        }
    }

    return OriginalCreateProcessW(
        lpApplicationName, lpCommandLine,
        lpProcessAttributes, lpThreadAttributes,
        bInheritHandles, dwCreationFlags,
        lpEnvironment, lpCurrentDirectory,
        lpStartupInfo, lpProcessInformation
    );
}

// ==================== 子进程 hook DLL 传播 ====================
//
// 关键问题：Chromium / Electron / Trae / VSCode 在 Windows 上是"launcher 立即派生真主进程"模型。
//   chrome.exe (PID 100, launcher) → 立即 CreateProcessW 派生 chrome.exe (PID 200, 真主进程) → launcher 退出
// 我们把 hook DLL 注入到 launcher 进程，但 launcher 立即死。子进程（真主进程）不会自动加载 hook DLL，
// 子进程内的 ShellExecute/CreateProcessW 调用不会被拦截，导致"实例内弹出的浏览器没走实例环境"。
//
// 解决：在 launcher 内 hook NtCreateUserProcess（所有进程创建的最终入口），
// 检测到 launcher 派生 box 内的子进程时，用 QueueUserAPC 把 LoadLibraryW 调用排队到子进程主线程。
// 子进程启动后第一个 alertable 状态时会执行该 APC，加载 hook DLL。
// 子进程内的 hook DLL 加载后再 hook 自己的 NtCreateUserProcess，递归传播给孙子进程。
//
// 注意：必须用 QueueUserAPC 而不是 CreateRemoteThread + LoadLibraryW：
//   - 子进程主线程在 NtCreateUserProcess 返回时可能还没准备好接受远程线程
//   - QueueUserAPC 在子进程进入第一个 alertable 状态时自动执行（SleepEx/WaitForSingleObjectEx 等）
//   - Chromium 子进程在启动早期会调 MsgWaitForMultipleObjectsEx（消息循环），足够触发 APC

// 遍历 RTL_USER_PROCESS_PARAMETERS 的环境块，查找指定 KEY 是否存在
// 环境块格式：KEY1=VALUE1\0KEY2=VALUE2\0...\0
// 找到返回 TRUE（且 *outValue 指向等号后的 VALUE 起始位置）
static BOOL FindEnvValue(PWSTR environment, LPCWSTR key, LPCWSTR* outValue) {
    if (!environment || !key) return FALSE;
    size_t keyLen = wcslen(key);
    PWSTR p = environment;
    while (*p) {
        // 计算当前 entry 长度（到下一个 \0）
        size_t entryLen = 0;
        while (p[entryLen] != L'\0') entryLen++;
        // 检查前缀 key=
        if (entryLen > keyLen && p[keyLen] == L'=' &&
            _wcsnicmp(p, key, keyLen) == 0) {
            if (outValue) *outValue = p + keyLen + 1;
            return TRUE;
        }
        p += entryLen + 1;
    }
    return FALSE;
}

// 判断子进程是否需要注入 hook DLL
//
// 修复点：原逻辑只对"同镜像名 + --type=/--user-data-dir="的子进程注入，
// 这导致 VSCode/Trae 的 helper（Code Helper.exe / Trae Helper.exe）注入不到。
// 实际上：launcher 启动子进程时，子进程继承 launcher 的环境块，
// 而环境块里包含 MULTIOPEN_BOX_NAME / MULTIOPEN_USER_DATA_DIR 等 box 标识。
// 凡是继承了这些 env 的子进程，都属于本 box 的进程树，都需要注入 hook。
//
// 三重检查（任一命中即注入）：
//   1. 子进程环境块包含 MULTIOPEN_BOX_NAME（最强信号，env 继承）
//   2. 子进程命令行包含本 box 的 --user-data-dir（Chromium 系子进程）
//   3. 子进程镜像路径与 box 应用路径相同（同 exe 名的子进程）
static BOOL IsMainWorkBuddyProcess(void);

static BOOL ShouldInjectHookDllToChild(PRTL_USER_PROCESS_PARAMETERS procParams) {
    if (!g_hookEnabled || !procParams || !g_thisDllPath[0]) {
        return FALSE;
    }
    PUNICODE_STRING imgPath = &procParams->ImagePathName;
    PUNICODE_STRING cmdLine = &procParams->CommandLine;
    if (!imgPath || !imgPath->Buffer || !imgPath->Length) return FALSE;
    if (!cmdLine || !cmdLine->Buffer) return FALSE;

    // Trae/Chromium 的 renderer 是沙箱化的高敏感进程。对 renderer 注入
    // ntdll/注册表/设备信息 hook 会导致 Chromium 把它判定为启动失败，
    // 最终在 Trae 日志中表现为：renderer process gone / launch-failed / 18。
    // URL 重定向由已注入的 Trae 主进程和浏览器 launcher 负责，不需要把
    // hook DLL 强行加载到页面 renderer 中。
    if (wcsstr(cmdLine->Buffer, L"--type=renderer") ||
        wcsstr(cmdLine->Buffer, L"--type=gpu-process") ||
        wcsstr(cmdLine->Buffer, L"--type=crashpad-handler")) {
        HookLog("Skip hook injection for sensitive Chromium child");
        return FALSE;
    }
    // Network/monitor services are latency- and sandbox-sensitive and never
    // originate user-facing URL opens. Keep the hook only in the main process
    // and Node/native-extension helpers that may own the openBrowser call.
    if (wcsstr(cmdLine->Buffer, L"--type=utility") &&
        (wcsstr(cmdLine->Buffer, L"network.mojom.NetworkService") ||
         wcsstr(cmdLine->Buffer, L"monitor.mojom.MonitorService") ||
         wcsstr(cmdLine->Buffer, L"audio.mojom.AudioService") ||
         wcsstr(cmdLine->Buffer, L"data_decoder.mojom.DataDecoderService"))) {
        HookLog("Skip hook injection for non-interactive utility child");
        return FALSE;
    }

    // 检查 1：环境块含 MULTIOPEN_BOX_NAME（env 继承是强信号，覆盖所有后代）
    // 关键修复：当 procParams->Environment 为 NULL 时，表示子进程继承父进程的环境块。
    // 当前进程已加载 hook DLL（g_hookEnabled=TRUE），说明父进程环境中有 MULTIOPEN_BOX_NAME。
    // 子进程继承父进程环境 → 子进程也会有 MULTIOPEN_BOX_NAME → 应该注入。
    // 之前 NULL 环境直接跳过了检查，导致 cmd.exe 等子进程不注入，URL 逃逸到系统浏览器。
    if (procParams->Environment) {
        // 显式提供了环境块：检查是否包含 MULTIOPEN_BOX_NAME
        if (FindEnvValue(procParams->Environment, L"MULTIOPEN_BOX_NAME", NULL)) {
            return TRUE;
        }
        // 显式提供了环境块但不含 MULTIOPEN_BOX_NAME：说明子进程不在 box 内，不注入
    } else {
        // NULL 环境块 = 继承父进程环境。父进程有 hook（g_hookEnabled=TRUE），
        // 所以子进程也会继承 MULTIOPEN_BOX_NAME 等环境变量 → 必须注入
        return TRUE;
    }

    // 检查 2：命令行包含本 box 的 --user-data-dir（Chromium 子进程即使换了镜像名也能识别）
    WCHAR ourUserDataDir[MAX_PATH] = { 0 };
    GetEnvironmentVariableW(L"MULTIOPEN_USER_DATA_DIR", ourUserDataDir, MAX_PATH);
    if (ourUserDataDir[0]) {
        // 构造 "--user-data-dir=<our path>" 形式查找
        WCHAR marker[MAX_PATH + 32] = { 0 };
        _snwprintf(marker, MAX_PATH + 32, L"--user-data-dir=%s", ourUserDataDir);
        if (wcsstr(cmdLine->Buffer, marker)) {
            return TRUE;
        }
    }

    // 检查 3：同镜像名（同 exe 的子进程，老 Chromium 进程模型）
    if (g_appPath[0] && _wcsicmp(imgPath->Buffer, g_appPath) == 0) {
        return TRUE;
    }

    // A sanitized environment without an instance marker is not sufficient
    // proof that this is a safe child. Fail closed instead of injecting into
    // arbitrary Chromium helpers; renderer/GPU/crashpad injection is known to
    // cause launch-failed/code 18.
    return FALSE;
}

// ==================== 子进程 hook DLL 注入（CreateRemoteThread 方式） ====================
//
// 关键修复：原实现用 QueueUserAPC 排队 LoadLibraryW 到子进程主线程，但 APC 只有在
// 线程进入 alertable 状态（SleepEx/WaitForSingleObjectEx 等）时才执行。
// Chromium 子进程主线程可能很久不进入 alertable，导致 hook DLL 迟迟不加载，
// 用户点链接时 hook 还没装上，浏览器就跑到实例环境外了。
//
// 改用 CreateRemoteThread + LoadLibraryW：在子进程中创建一个新线程立即执行 LoadLibraryW，
// 不依赖目标线程的 alertable 状态，hook DLL 立即加载生效。
// 这与 injector.ts 中 launchWithDllInjection 的注入方式完全一致，已验证可靠。

static BOOL InjectHookDllToChild(HANDLE procHandle, HANDLE threadHandle) {
    if (!g_thisDllPath[0]) return FALSE;
    if (!procHandle) return FALSE;
    (void)threadHandle; // CreateRemoteThread 不需要主线程句柄

    DWORD childPid = GetProcessId(procHandle);
    WCHAR initEventName[96] = { 0 };
    _snwprintf(initEventName, 95, L"Local\\WorkBuddyMultiopenInit_%lu", childPid);
    HANDLE initEvent = CreateEventW(NULL, TRUE, FALSE, initEventName);

    // 1. 在子进程分配内存存放 DLL 路径（UTF-16）
    size_t pathBytes = (wcslen(g_thisDllPath) + 1) * sizeof(WCHAR);
    PVOID remoteMem = VirtualAllocEx(procHandle, NULL, pathBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteMem) {
        HookLog("Inject: VirtualAllocEx failed err=%lu", GetLastError());
        if (initEvent) CloseHandle(initEvent);
        return FALSE;
    }

    // 2. 写入 DLL 路径
    SIZE_T written = 0;
    if (!WriteProcessMemory(procHandle, remoteMem, g_thisDllPath, pathBytes, &written)) {
        HookLog("Inject: WriteProcessMemory failed err=%lu", GetLastError());
        VirtualFreeEx(procHandle, remoteMem, 0, MEM_RELEASE);
        if (initEvent) CloseHandle(initEvent);
        return FALSE;
    }

    // 3. 获取 kernel32!LoadLibraryW 的地址
    //    Windows 保证 kernel32.dll 在所有 64 位进程中的基址一致
    HMODULE hKernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!hKernel32) {
        VirtualFreeEx(procHandle, remoteMem, 0, MEM_RELEASE);
        if (initEvent) CloseHandle(initEvent);
        return FALSE;
    }
    FARPROC loadLibAddr = GetProcAddress(hKernel32, "LoadLibraryW");
    if (!loadLibAddr) {
        VirtualFreeEx(procHandle, remoteMem, 0, MEM_RELEASE);
        if (initEvent) CloseHandle(initEvent);
        return FALSE;
    }

    // 4. 创建远程线程执行 LoadLibraryW(dllPath)
    //    新线程立即运行，不需要等 alertable 状态
    DWORD remoteTid = 0;
    HANDLE hRemoteThread = CreateRemoteThread(
        procHandle, NULL, 0,
        (LPTHREAD_START_ROUTINE)loadLibAddr,
        remoteMem, 0, &remoteTid);
    if (!hRemoteThread) {
        HookLog("Inject: CreateRemoteThread failed err=%lu", GetLastError());
        VirtualFreeEx(procHandle, remoteMem, 0, MEM_RELEASE);
        if (initEvent) CloseHandle(initEvent);
        return FALSE;
    }

    // 5. 等待远程线程完成。子进程创建路径不能被每次同步阻塞 5 秒。
    DWORD waitResult = WaitForSingleObject(hRemoteThread, 1500);
    if (waitResult != WAIT_OBJECT_0) {
        HookLog("Inject: LoadLibrary thread timeout/failure wait=%lu", waitResult);
        CloseHandle(hRemoteThread);
        if (initEvent) CloseHandle(initEvent);
        // 远程线程可能仍会读取路径；此时不能释放 remoteMem，宁可在子进程
        // 生命周期内泄漏这几十字节，也不能制造 use-after-free。
        return FALSE;
    }
    DWORD loadResult = 0;
    GetExitCodeThread(hRemoteThread, &loadResult);
    CloseHandle(hRemoteThread);

    // 6. 释放远程内存（LoadLibraryW 已经把 DLL 路径复制到自己的内部结构中）
    VirtualFreeEx(procHandle, remoteMem, 0, MEM_RELEASE);

    // LoadLibrary returning only means DllMain returned. The real MinHook setup
    // runs on a loader-lock-safe worker; wait for that worker before allowing
    // the child creation path to continue.
    if (!initEvent || WaitForSingleObject(initEvent, 5000) != WAIT_OBJECT_0) {
        HookLog("Inject: initialization handshake timeout pid=%lu", childPid);
        if (initEvent) CloseHandle(initEvent);
        return FALSE;
    }
    CloseHandle(initEvent);

    if (loadResult == 0) {
        HookLog("Inject: LoadLibraryW returned NULL (tid=%lu)", remoteTid);
        return FALSE;
    }
    HookLog("Inject: hook DLL loaded in child via CreateRemoteThread (pid via handle, tid=%lu)", remoteTid);
    return TRUE;
}

// ==================== NtCreateUserProcess hook（底层进程创建拦截） ====================
//
// 这是所有进程创建的最终入口（CreateProcessW/ShellExecuteExW 内部都调用它）。
// hook ntdll.dll 的函数不存在 kernel32/KernelBase 转发问题，与现有 NtCreateMutant 等 hook
// 使用相同的机制，可靠性有保证。
//
// 实现：检测 ProcessParameters->CommandLine 是否包含 http/https URL，
// 如果是则改写 ImagePathName 和 CommandLine 为实例应用路径 + URL，
// 调用原函数后恢复原始值。

static PFN_NtCreateUserProcess OriginalNtCreateUserProcess = NULL;

static NTSTATUS NTAPI HookNtCreateUserProcess(
    PHANDLE ProcessHandle,
    PHANDLE ThreadHandle,
    ACCESS_MASK ProcessDesiredAccess,
    ACCESS_MASK ThreadDesiredAccess,
    POBJECT_ATTRIBUTES ProcessObjectAttributes,
    POBJECT_ATTRIBUTES ThreadObjectAttributes,
    ULONG ProcessFlags,
    ULONG ThreadFlags,
    PRTL_USER_PROCESS_PARAMETERS ProcessParameters,
    PVOID CreateInfo,
    PVOID AttributeList)
{
    NTSTATUS status;
    BOOL doInject = FALSE;
    PUNICODE_STRING imgPath = NULL;
    UNICODE_STRING origImgPath = { 0 };
    PUNICODE_STRING cmdLine = NULL;
    UNICODE_STRING origCmdLine = { 0 };
    LPWSTR newCmdLine = NULL;
    LPWSTR newImgBuf = NULL;
    LPWSTR url = NULL;
    BOOL urlRedirected = FALSE;

    if (g_hookEnabled && ProcessParameters) {
        cmdLine = &ProcessParameters->CommandLine;
        imgPath = &ProcessParameters->ImagePathName;
        if (cmdLine && cmdLine->Buffer && cmdLine->Length > 0) {
            // 第一步：URL 重定向（实例内应用点击外部链接时，把浏览器启动改到实例的浏览器）
            if (wcsstr(cmdLine->Buffer, L"http")) {
                url = ExtractUrlFromCommandLine(cmdLine->Buffer);
                if (url) {
                    WCHAR redirectPath[MAX_PATH] = { 0 };
                    if (GetRedirectTarget(redirectPath, MAX_PATH) && imgPath && imgPath->Buffer) {
                        // 如果已经是重定向目标路径，不重复处理（避免无限递归）
                        if (!IsAlreadyRedirectTarget(imgPath->Buffer)) {
                            newCmdLine = BuildRedirectCommandLine(redirectPath, url);
                            if (newCmdLine) {
                                size_t redirectPathLen = wcslen(redirectPath);
                                newImgBuf = (LPWSTR)HeapAlloc(GetProcessHeap(), 0, (redirectPathLen + 1) * sizeof(WCHAR));
                                if (newImgBuf) {
                                    wcscpy(newImgBuf, redirectPath);
                                    // 保存原始值，调用后恢复
                                    origCmdLine = *cmdLine;
                                    origImgPath = *imgPath;
                                    size_t newCmdLen = wcslen(newCmdLine);
                                    cmdLine->Buffer = newCmdLine;
                                    cmdLine->Length = (USHORT)(newCmdLen * sizeof(WCHAR));
                                    cmdLine->MaximumLength = (USHORT)((newCmdLen + 1) * sizeof(WCHAR));
                                    imgPath->Buffer = newImgBuf;
                                    imgPath->Length = (USHORT)(redirectPathLen * sizeof(WCHAR));
                                    imgPath->MaximumLength = (USHORT)((redirectPathLen + 1) * sizeof(WCHAR));
                                    urlRedirected = TRUE;
                                    HookLog("Redirect NtCreateUserProcess to browser: %S user_data_dir=%S", redirectPath, g_browserUserDataDir);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 第二步：检查是否需要注入 hook DLL 到子进程
    // （仅在 launcher 派生 box 内子进程时需要，例如 chrome.exe 派生真主进程和子进程）
    // In the normal browser-hook route, keep the DLL exclusively in the
    // WorkBuddy main process. Injecting into descendants is unnecessary for
    // URL routing and can interfere with Windows text services/IME.
    WCHAR browserOnly[8] = { 0 };
    GetEnvironmentVariableW(L"MULTIOPEN_ENABLE_BROWSER_HOOKS", browserOnly, 8);
    doInject = (browserOnly[0] == L'1' && !IsMainWorkBuddyProcess())
        ? FALSE
        : ShouldInjectHookDllToChild(ProcessParameters);

    // 第三步：调用原始 NtCreateUserProcess 创建子进程
    status = OriginalNtCreateUserProcess(
        ProcessHandle, ThreadHandle,
        ProcessDesiredAccess, ThreadDesiredAccess,
        ProcessObjectAttributes, ThreadObjectAttributes,
        ProcessFlags, ThreadFlags,
        ProcessParameters, CreateInfo, AttributeList
    );

    // 第四步：恢复原始值（如果做过 URL 重定向）
    if (urlRedirected && imgPath && cmdLine) {
        *cmdLine = origCmdLine;
        *imgPath = origImgPath;
    }

    // 第五步：注入 hook DLL 到子进程（用 CreateRemoteThread 立即创建远程线程执行 LoadLibraryW）
    // 不依赖 alertable 状态，hook DLL 立即加载生效，确保子进程的 ShellExecute/CreateProcessW hook 在第一时间装上
    if (NT_SUCCESS(status) && doInject && ProcessHandle && ThreadHandle
        && *ProcessHandle && *ThreadHandle) {
        InjectHookDllToChild(*ProcessHandle, *ThreadHandle);
    }

    // 清理 URL 重定向分配的内存
    if (newCmdLine) HeapFree(GetProcessHeap(), 0, newCmdLine);
    if (newImgBuf) HeapFree(GetProcessHeap(), 0, newImgBuf);
    if (url) HeapFree(GetProcessHeap(), 0, url);

    return status;
}

// ==================== Hook 安装 ====================

// 通用 hook 创建辅助。所有 hook 创建完成后统一 Enable，避免每新增一个
// hook 都重复 Enable(MH_ALL_HOOKS) 造成部分初始化/重复启用错误。
static BOOL CreateHookOnly(LPCWSTR dllName, LPCSTR funcName, void* hookFunc, void** originalFunc) {
    if (MH_CreateHookApi(dllName, funcName, hookFunc, originalFunc) != MH_OK) {
        HookLog("Failed to create hook for %ls!%s", dllName, funcName);
        return FALSE;
    }
    HookLog("Hook created: %ls!%s", dllName, funcName);
    return TRUE;
}

// Namespace hooks are needed for WorkBuddy's singleton lock, but must not be
// installed in Electron renderers or system/text-input children. Those
// processes use named objects belonging to Windows IME/TSF and can become
// unresponsive when their names are rewritten.
static BOOL IsMainWorkBuddyProcess(void) {
    WCHAR modulePath[MAX_PATH] = { 0 };
    DWORD length = GetModuleFileNameW(NULL, modulePath, MAX_PATH);
    if (!length || !g_appPath[0] || _wcsicmp(modulePath, g_appPath) != 0) return FALSE;
    return wcsstr(GetCommandLineW(), L"--type=") == NULL;
}

// shell32.dll 在进程极早期（CREATE_SUSPENDED 注入时）可能尚未加载，
// MinHook 的 MH_CreateHookApi 内部 LoadLibrary(shell32) 会失败，导致
// ShellExecuteW/ExW 钩子装不上——WorkBuddy 的 shell.openExternal 就会落到
// 系统默认浏览器（主机账号）。延迟到 shell32 加载完成后再补装。
static BOOL g_shellHooksInstalled = FALSE;

static BOOL InstallShellHooks(void) {
    if (g_shellHooksInstalled) return TRUE;
    BOOL ok = TRUE;
    ok &= CreateHookOnly(L"shell32.dll", "ShellExecuteW", &HookShellExecuteW, (void**)&OriginalShellExecuteW);
    ok &= CreateHookOnly(L"shell32.dll", "ShellExecuteExW", &HookShellExecuteExW, (void**)&OriginalShellExecuteExW);
    if (ok) {
        if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
            HookLog("Failed to enable shell hooks");
            return FALSE;
        }
        g_shellHooksInstalled = TRUE;
        HookLog("ShellExecute hooks installed");
    } else {
        HookLog("ShellExecute hooks not ready yet, will retry");
    }
    return ok;
}

static DWORD WINAPI RetryShellHooksWorker(LPVOID lpParam) {
    (void)lpParam;
    const DWORD delaysMs[] = { 1000, 3000, 8000, 15000, 30000 };
    for (int i = 0; i < 5 && !g_shellHooksInstalled; i++) {
        Sleep(delaysMs[i]);
        InstallShellHooks();
    }
    return 0;
}

static BOOL InstallAllHooks(void) {
    if (MH_Initialize() != MH_OK) {
        HookLog("MH_Initialize failed");
        return FALSE;
    }

    // 子进程注入改用 kernel32 API（VirtualAllocEx/CreateRemoteThread），无需解析 ntdll 内部函数

    BOOL ok = TRUE;
    WCHAR browserOnly[8] = { 0 };
    GetEnvironmentVariableW(L"MULTIOPEN_ENABLE_BROWSER_HOOKS", browserOnly, 8);
    if (browserOnly[0] == L'1') {
        // The normal instance route needs two narrowly scoped boundaries:
        // browser launches must stay in the instance browser profile, and
        // WorkBuddy's named singleton objects must be namespaced per box.
        // Do not enable device identity, registry, or file-I/O rewriting here.
        if (IsMainWorkBuddyProcess()) {
        // Browser routing belongs to the WorkBuddy main process. Do not
        // install these hooks in Electron renderers/utilities or in the
        // browser children; Windows TSF/IME must communicate with those
        // processes without injected API shims.
            ok &= CreateHookOnly(L"kernel32.dll", "CreateProcessW", &HookCreateProcessW, (void**)&OriginalCreateProcessW);
            ok &= CreateHookOnly(L"ntdll.dll", "NtCreateMutant", &HookNtCreateMutant, (void**)&OriginalNtCreateMutant);
            ok &= CreateHookOnly(L"ntdll.dll", "NtOpenMutant", &HookNtOpenMutant, (void**)&OriginalNtOpenMutant);
            // shell32 钩子可能因 DLL 尚未加载而失败，稍后自动重试
            BOOL shellOk = InstallShellHooks();
            ok &= shellOk;
            if (!shellOk) {
                HANDLE retry = CreateThread(NULL, 0, RetryShellHooksWorker, NULL, 0, NULL);
                if (retry) CloseHandle(retry);
            }
            HookLog("Browser routing and minimal mutex namespace hooks enabled in WorkBuddy main process only");
        } else {
            HookLog("Skipping browser and instance namespace hooks in child process");
        }
        if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) return FALSE;
        HookLog("Browser and instance-namespace hooks enabled");
        return ok;
    }
    ok &= CreateHookOnly(L"ntdll.dll", "NtCreateMutant",    &HookNtCreateMutant,    (void**)&OriginalNtCreateMutant);
    ok &= CreateHookOnly(L"ntdll.dll", "NtOpenMutant",      &HookNtOpenMutant,      (void**)&OriginalNtOpenMutant);
    ok &= CreateHookOnly(L"ntdll.dll", "NtCreateEvent",     &HookNtCreateEvent,     (void**)&OriginalNtCreateEvent);
    ok &= CreateHookOnly(L"ntdll.dll", "NtOpenEvent",       &HookNtOpenEvent,       (void**)&OriginalNtOpenEvent);
    ok &= CreateHookOnly(L"ntdll.dll", "NtCreateSemaphore", &HookNtCreateSemaphore, (void**)&OriginalNtCreateSemaphore);
    ok &= CreateHookOnly(L"ntdll.dll", "NtOpenSemaphore",   &HookNtOpenSemaphore,   (void**)&OriginalNtOpenSemaphore);

    // Physical-device identity hooks (MachineGuid, computer name, SMBIOS and
    // hardware metadata) are intentionally not installed. A process instance
    // is not a separate physical device, and rewriting provider-facing identity
    // fields is not part of the supported isolation boundary.

    // The normal browser-hook route above also installs only the narrow
    // instance namespace hooks needed for WorkBuddy's singleton objects. It
    // still does not install device identity, registry, or file-I/O rewriting.

    if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
        HookLog("Failed to enable created hooks");
        return FALSE;
    }
    HookLog("Created hooks enabled");

    return ok;
}

static void UninstallAllHooks(void) {
    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();
}

// ==================== DLL 入口 ====================

static DWORD WINAPI InitializeHooksWorker(LPVOID unused) {
    (void)unused;
    // Create/open the rendezvous event before event hooks are enabled. The
    // external injector creates this exact name and waits for SetEvent below.
    WCHAR initEventName[96] = { 0 };
    _snwprintf(initEventName, 95, L"Local\\WorkBuddyMultiopenInit_%lu", GetCurrentProcessId());
    g_initCompleteEvent = CreateEventW(NULL, TRUE, FALSE, initEventName);

    LoadConfig();
    if (g_hookEnabled) {
        BOOL ok = InstallAllHooks();
        HookLog("Hook DLL initialized outside loader lock: %s", ok ? "ok" : "partial/failure");
    } else {
        HookLog("Hook DLL loaded but disabled (no box name)");
    }
    if (g_initCompleteEvent) SetEvent(g_initCompleteEvent);
    return 0;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD dwReason, LPVOID lpReserved) {
    (void)lpReserved;
    switch (dwReason) {
    case DLL_PROCESS_ATTACH: {
        DisableThreadLibraryCalls(hModule);
        // DllMain runs under the Windows loader lock. File I/O, registry work
        // and MinHook initialization are deferred to a worker that can only run
        // after this callback returns. Never wait for the worker here.
        HANDLE initThread = CreateThread(NULL, 0, InitializeHooksWorker, NULL, 0, NULL);
        if (initThread) {
            CloseHandle(initThread);
        }
        break;
    }
    case DLL_PROCESS_DETACH:
        // Process teardown releases the module and hooks. Calling MinHook while
        // the loader lock is held can deadlock, so no teardown work is done here.
        break;
    }
    return TRUE;
}
