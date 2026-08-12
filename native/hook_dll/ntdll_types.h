// NT API 类型定义
// Windows SDK 的 winternl.h 不完整，这里手动声明 hook 所需的类型
#ifndef NTDLL_TYPES_H
#define NTDLL_TYPES_H

#include <windows.h>

// NT 状态码类型（windows.h 不一定提供，winternl.h 会与下方类型定义冲突，故自行声明）
#ifndef _NTSTATUS_DEFINED
typedef LONG NTSTATUS;
#define _NTSTATUS_DEFINED
#endif

// NT 状态码
#ifndef STATUS_SUCCESS
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#endif

// 缓冲区不足（NtQueryValueKey 返回，提示调用方用更大缓冲区重试）
#ifndef STATUS_BUFFER_OVERFLOW
#define STATUS_BUFFER_OVERFLOW ((NTSTATUS)0x80000005L)
#endif

// NT_SUCCESS 宏（ntdll/winternl 头文件可能不提供；>=0 即成功）
#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

// Unicode 字符串（NT 内部格式）
typedef struct _UNICODE_STRING {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR  Buffer;
} UNICODE_STRING, *PUNICODE_STRING;

// 对象属性（NtCreate* 系列函数的通用参数）
typedef struct _OBJECT_ATTRIBUTES {
    ULONG           Length;
    HANDLE          RootDirectory;
    PUNICODE_STRING ObjectName;
    ULONG           Attributes;
    PVOID           SecurityDescriptor;
    PVOID           SecurityQualityOfService;
} OBJECT_ATTRIBUTES, *POBJECT_ATTRIBUTES;

#define OBJ_CASE_INSENSITIVE 0x00000040L

// NT 函数指针类型
typedef NTSTATUS (NTAPI *PFN_NtCreateMutant)(
    PHANDLE             MutantHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    BOOLEAN             InitialOwner
);

typedef NTSTATUS (NTAPI *PFN_NtOpenMutant)(
    PHANDLE             MutantHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes
);

typedef NTSTATUS (NTAPI *PFN_NtCreateEvent)(
    PHANDLE             EventHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    int                 EventType,
    BOOLEAN             InitialState
);

typedef NTSTATUS (NTAPI *PFN_NtOpenEvent)(
    PHANDLE             EventHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes
);

typedef NTSTATUS (NTAPI *PFN_NtCreateSemaphore)(
    PHANDLE             SemaphoreHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    LONG                InitialCount,
    LONG                MaximumCount
);

typedef NTSTATUS (NTAPI *PFN_NtOpenSemaphore)(
    PHANDLE             SemaphoreHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes
);

typedef NTSTATUS (NTAPI *PFN_NtCreateSection)(
    PHANDLE             SectionHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    PLARGE_INTEGER      MaximumSize,
    ULONG               SectionPageProtection,
    ULONG               AllocationAttributes,
    HANDLE              FileHandle
);

typedef NTSTATUS (NTAPI *PFN_NtOpenSection)(
    PHANDLE             SectionHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes
);

typedef NTSTATUS (NTAPI *PFN_NtCreateFile)(
    PHANDLE             FileHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    PVOID               IoStatusBlock,
    PLARGE_INTEGER      AllocationSize,
    ULONG               FileAttributes,
    ULONG               ShareAccess,
    ULONG               CreateDisposition,
    ULONG               CreateOptions,
    PVOID               EaBuffer,
    ULONG               EaLength
);

typedef NTSTATUS (NTAPI *PFN_NtOpenFile)(
    PHANDLE             FileHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    PVOID               IoStatusBlock,
    ULONG               ShareAccess,
    ULONG               OpenOptions
);

typedef NTSTATUS (NTAPI *PFN_NtCreateKey)(
    PHANDLE             KeyHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes,
    ULONG               TitleIndex,
    PVOID               Class,
    ULONG               CreateOptions,
    PULONG              Disposition
);

typedef NTSTATUS (NTAPI *PFN_NtOpenKey)(
    PHANDLE             KeyHandle,
    ACCESS_MASK         DesiredAccess,
    POBJECT_ATTRIBUTES  ObjectAttributes
);

// ==================== NtCreateUserProcess 相关类型 ====================
//
// NtCreateUserProcess 是 ntdll.dll 中所有进程创建的底层入口：
// CreateProcessW / CreateProcessAsUserW / ShellExecuteExW 最终都调用它。
// hook 此函数能 100% 覆盖进程创建路径，不受 kernel32/KernelBase 转发影响。
//
// RTL_USER_PROCESS_PARAMETERS（winternl.h 简化版定义）：
//   偏移 0:   Reserved1[16]  (16 bytes)
//   偏移 16:  Reserved2[10]  (80 bytes, 10 * 8 指针，含 ConsoleHandle / StdInput /
//             CurrentDirectory / DllPath 等)
//   偏移 96:  ImagePathName  (UNICODE_STRING, 16 bytes)
//   偏移 112: CommandLine    (UNICODE_STRING, 16 bytes)
//   偏移 128: Environment    (PVOID, 8 bytes，指向子进程的环境块;
//             hook DLL 用它检测子进程是否继承本 box 的 MULTIOPEN_BOX_NAME)
typedef struct _RTL_USER_PROCESS_PARAMETERS {
    BYTE Reserved1[16];
    PVOID Reserved2[10];
    UNICODE_STRING ImagePathName;
    UNICODE_STRING CommandLine;
    PVOID Environment;
} RTL_USER_PROCESS_PARAMETERS, *PRTL_USER_PROCESS_PARAMETERS;

// NtCreateUserProcess 函数指针类型
// CreateInfo (PPS_CREATE_INFO) 和 AttributeList (PPS_ATTRIBUTE_LIST) 结构复杂，
// hook 中不读取/修改它们，直接透传给原函数，故用 PVOID
typedef NTSTATUS (NTAPI *PFN_NtCreateUserProcess)(
    PHANDLE                     ProcessHandle,
    PHANDLE                     ThreadHandle,
    ACCESS_MASK                 ProcessDesiredAccess,
    ACCESS_MASK                 ThreadDesiredAccess,
    POBJECT_ATTRIBUTES          ProcessObjectAttributes,
    POBJECT_ATTRIBUTES          ThreadObjectAttributes,
    ULONG                       ProcessFlags,
    ULONG                       ThreadFlags,
    PRTL_USER_PROCESS_PARAMETERS ProcessParameters,
    PVOID                       CreateInfo,
    PVOID                       AttributeList
);

// ==================== NtQueryValueKey 相关类型 ====================
//
// 用于 hook NtQueryValueKey，直接返回伪造的 MachineGuid 值。
// 此方案不依赖写 HKLM 注册表（不需要管理员权限），比注册表键重定向更可靠。
// RegQueryValueExW 内部调用 NtQueryValueKey，因此 hook 此函数能覆盖所有注册表值查询。

typedef enum _KEY_VALUE_INFORMATION_CLASS {
    KeyValueBasicInformation = 0,
    KeyValueFullInformation = 1,
    KeyValuePartialInformation = 2,
    KeyValueFullInformationAlign64 = 3,
    KeyValuePartialInformationAlign64 = 4
} KEY_VALUE_INFORMATION_CLASS;

// KeyValuePartialInformation：RegQueryValueExW 最常用的查询类型
// 包含 Type 和 Data，不包含值名（调用方已知值名）
typedef struct _KEY_VALUE_PARTIAL_INFORMATION {
    ULONG   TitleIndex;
    ULONG   Type;
    ULONG   DataLength;
    UCHAR   Data[1];
} KEY_VALUE_PARTIAL_INFORMATION, *PKEY_VALUE_PARTIAL_INFORMATION;

// KeyValueFullInformation：包含值名 + Type + Data
typedef struct _KEY_VALUE_FULL_INFORMATION {
    ULONG   TitleIndex;
    ULONG   Type;
    ULONG   DataOffset;
    ULONG   DataLength;
    ULONG   NameLength;
    WCHAR   Name[1];
} KEY_VALUE_FULL_INFORMATION, *PKEY_VALUE_FULL_INFORMATION;

// KeyValueBasicInformation：只包含值名 + Type，不含 Data
typedef struct _KEY_VALUE_BASIC_INFORMATION {
    ULONG   TitleIndex;
    ULONG   Type;
    ULONG   NameLength;
    WCHAR   Name[1];
} KEY_VALUE_BASIC_INFORMATION, *PKEY_VALUE_BASIC_INFORMATION;

typedef NTSTATUS (NTAPI *PFN_NtQueryValueKey)(
    HANDLE                      KeyHandle,
    PUNICODE_STRING             ValueName,
    KEY_VALUE_INFORMATION_CLASS KeyValueInformationClass,
    PVOID                       KeyValueInformation,
    ULONG                       Length,
    PULONG                      ResultLength
);

// NtClose 函数指针类型（用于句柄关闭时清理追踪表）
typedef NTSTATUS (NTAPI *PFN_NtClose)(HANDLE Handle);

#endif // NTDLL_TYPES_H
