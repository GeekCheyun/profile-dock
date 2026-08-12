// 浏览器指纹覆盖脚本生成器
//
// 生成注入到浏览器页面的 JS 脚本，覆盖所有 JS 可读的浏览器指纹：
// 1. navigator.userAgent / platform / hardwareConcurrency / deviceMemory / languages
// 2. screen.width / height / colorDepth / availWidth / availHeight
// 3. Canvas 指纹（toDataURL / getImageData 注入确定性噪声）
// 4. WebGL 指纹（getParameter 覆盖 UNMASKED_VENDOR / UNMASKED_RENDERER）
// 5. AudioContext 指纹（getChannelData 注入确定性噪声）
// 6. 时区（Date.getTimezoneOffset / Intl.DateTimeFormat resolvedOptions）
//
// 设计原则：
// - 确定性：同一实例每次注入相同噪声（基于 seed），不同实例噪声不同
// - 透明性：覆盖后的 API 行为与原始 API 一致，仅指纹值不同
// - 抗检测：覆盖在页面任何 JS 执行前完成（CDP Page.addScriptToEvaluateOnNewDocument）

import type { InstanceFingerprint } from './types.js'

/**
 * 生成浏览器指纹覆盖脚本
 * 此脚本通过 CDP Page.addScriptToEvaluateOnNewDocument 注入，
 * 在每个新文档创建时、页面 JS 执行前运行。
 */
export function generateFingerprintScript(fp: InstanceFingerprint): string {
  // 只在有有效指纹数据时生成覆盖脚本
  if (!fp.userAgent && !fp.timezone && !fp.webglVendor) {
    return ''
  }

  // 构建配置对象（传入 JS 上下文）
  const config = {
    userAgent: fp.userAgent,
    platform: fp.platform || 'Win32',
    language: fp.language || 'en-US',
    languages: fp.language ? [fp.language, 'en-US'] : ['en-US'],
    hardwareConcurrency: fp.hardwareConcurrency || 8,
    deviceMemory: fp.deviceMemory || 8,
    screenWidth: fp.screenWidth || 1920,
    screenHeight: fp.screenHeight || 1080,
    colorDepth: fp.colorDepth || 24,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    canvasSeed: fp.canvasSeed || 0,
    audioSeed: fp.audioSeed || 0,
    timezone: fp.timezone,
  }

  return `
(function() {
  'use strict';
  var FP_CONFIG = ${JSON.stringify(config)};

  // ==================== navigator 属性覆盖 ====================
  try {
    var navigatorProto = Object.getPrototypeOf(navigator);
    var props = {
      userAgent: { get: function() { return FP_CONFIG.userAgent; } },
      appVersion: { get: function() { return FP_CONFIG.userAgent.replace('Mozilla/', ''); } },
      platform: { get: function() { return FP_CONFIG.platform; } },
      hardwareConcurrency: { get: function() { return FP_CONFIG.hardwareConcurrency; } },
      deviceMemory: { get: function() { return FP_CONFIG.deviceMemory; } },
      language: { get: function() { return FP_CONFIG.language; } },
      languages: { get: function() { return FP_CONFIG.languages.slice(); } },
    };
    for (var key in props) {
      Object.defineProperty(navigatorProto, key, props[key]);
    }
  } catch(e) {}

  // ==================== screen 属性覆盖 ====================
  try {
    var screenProto = Object.getPrototypeOf(screen);
    var screenProps = {
      width: { get: function() { return FP_CONFIG.screenWidth; } },
      height: { get: function() { return FP_CONFIG.screenHeight; } },
      availWidth: { get: function() { return FP_CONFIG.screenWidth; } },
      availHeight: { get: function() { return FP_CONFIG.screenHeight - 40; } },
      colorDepth: { get: function() { return FP_CONFIG.colorDepth; } },
      pixelDepth: { get: function() { return FP_CONFIG.colorDepth; } },
    };
    for (var key in screenProps) {
      Object.defineProperty(screenProto, key, screenProps[key]);
    }
  } catch(e) {}

  // ==================== Canvas 指纹噪声注入 ====================
  //
  // 原理：Canvas 指纹通过 toDataURL / getImageData 提取像素哈希。
  // 在返回结果中注入基于 seed 的确定性微小噪声，使哈希值改变但视觉无差异。
  try {
    var seed = FP_CONFIG.canvasSeed;
    if (seed > 0) {
      // 简单的确定性 PRNG（mulberry32）
      function mulberry32(a) {
        return function() {
          a |= 0; a = a + 0x6D2B79F5 | 0;
          var t = Math.imul(a ^ a >>> 15, 1 | a);
          t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
      }
      var rng = mulberry32(seed);

      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        var ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          try {
            var imageData = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
            var data = imageData.data;
            // 注入微小噪声：在 alpha 通道加 ±1 的确定性偏移
            for (var i = 3; i < data.length; i += 4) {
              if (data[i] > 0 && data[i] < 255) {
                data[i] = data[i] + (rng() > 0.5 ? 1 : -1);
              }
            }
            ctx.putImageData(imageData, 0, 0);
          } catch(e) {}
        }
        return origToDataURL.apply(this, arguments);
      };

      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function() {
        var imageData = origGetImageData.apply(this, arguments);
        // 仅对小区域（指纹探测典型尺寸）注入噪声
        if (imageData.width <= 64 && imageData.height <= 64) {
          var data = imageData.data;
          for (var i = 0; i < data.length; i += 4) {
            // RGB 通道各加 ±1 确定性噪声
            data[i] = Math.max(0, Math.min(255, data[i] + (rng() > 0.5 ? 1 : -1)));
            data[i+1] = Math.max(0, Math.min(255, data[i+1] + (rng() > 0.5 ? 1 : -1)));
            data[i+2] = Math.max(0, Math.min(255, data[i+2] + (rng() > 0.5 ? 1 : -1)));
          }
        }
        return imageData;
      };
    }
  } catch(e) {}

  // ==================== WebGL 指纹覆盖 ====================
  //
  // 覆盖 getParameter，当查询 UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL 时返回伪造值
  try {
    var UNMASKED_VENDOR = 0x9245;
    var UNMASKED_RENDERER = 0x9246;

    function patchWebGL(proto) {
      if (!proto) return;
      var origGetParameter = proto.getParameter;
      proto.getParameter = function(param) {
        if (param === UNMASKED_VENDOR) return FP_CONFIG.webglVendor;
        if (param === UNMASKED_RENDERER) return FP_CONFIG.webglRenderer;
        return origGetParameter.call(this, param);
      };
    }
    patchWebGL(WebGLRenderingContext && WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      patchWebGL(WebGL2RenderingContext.prototype);
    }
  } catch(e) {}

  // ==================== AudioContext 指纹噪声注入 ====================
  //
  // 原理：AudioContext 指纹通过 AnalyserNode.getFloatFrequencyData 提取音频哈希。
  // 在返回数据中注入基于 seed 的确定性噪声。
  try {
    var audioSeed = FP_CONFIG.audioSeed;
    if (audioSeed > 0) {
      function audioRng(a) {
        return function() {
          a |= 0; a = a + 0x6D2B79F5 | 0;
          var t = Math.imul(a ^ a >>> 15, 1 | a);
          t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
      }
      var aRng = audioRng(audioSeed);

      var origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        origGetFloatFrequencyData.call(this, array);
        for (var i = 0; i < array.length; i++) {
          array[i] += (aRng() - 0.5) * 0.0001;
        }
      };

      if (typeof AudioBuffer !== 'undefined') {
        var origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function() {
          var data = origGetChannelData.apply(this, arguments);
          // 仅对小 buffer 注入噪声（指纹探测典型尺寸）
          if (data.length <= 8192) {
            for (var i = 0; i < data.length; i++) {
              data[i] += (aRng() - 0.5) * 1e-7;
            }
          }
          return data;
        };
      }
    }
  } catch(e) {}

  // ==================== 时区覆盖 ====================
  //
  // 覆盖 Date.prototype.getTimezoneOffset 和 Intl.DateTimeFormat，
  // 使 JS 层时区与指纹配置一致（Chromium 命令行无法设置时区，必须 JS 覆盖）
  try {
    if (FP_CONFIG.timezone) {
      // 解析 IANA 时区名为 UTC 偏移（分钟）
      // 使用 Intl API 计算偏移（在覆盖前先获取真实值）
      var tz = FP_CONFIG.timezone;
      try {
        var formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          timeZoneName: 'shortOffset'
        });
        var parts = formatter.formatToParts(new Date());
        var offsetPart = parts.find(function(p) { return p.type === 'timeZoneName'; });
        if (offsetPart) {
          var offsetStr = offsetPart.value; // 如 "GMT+8" 或 "GMT-5:30"
          var match = offsetStr.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
          if (match) {
            var sign = match[1] === '+' ? -1 : 1; // getTimezoneOffset 返回相反符号
            var hours = parseInt(match[2], 10);
            var minutes = match[3] ? parseInt(match[3], 10) : 0;
            var totalMinutes = sign * (hours * 60 + minutes);

            var origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
            Date.prototype.getTimezoneOffset = function() {
              return totalMinutes;
            };
          }
        }
      } catch(e) {}

      // 覆盖 Intl.DateTimeFormat 的默认时区
      var origDateTimeFormat = Intl.DateTimeFormat;
      var origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function() {
        var options = origResolvedOptions.call(this);
        if (!options.timeZone || options.timeZone === 'UTC') {
          options.timeZone = tz;
        }
        return options;
      };
    }
  } catch(e) {}

})();
`
}
