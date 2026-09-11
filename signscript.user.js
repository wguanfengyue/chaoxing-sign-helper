// ==UserScript==
// @name         学习通签到助手（浏览器登录态版）
// @namespace    https://github.com/wguanfengyue/%E8%B6%85%E6%98%9F%E5%AD%A6%E4%B9%A0%E9%80%9A%E7%AD%BE%E5%88%B0%E5%8A%A9%E6%89%8B
// @version      3.5.0
// @description  在超星页面中检测签到活动；普通和旧版二维码可核对提交，位置签到进入超星官方定位流程。
// @author       wguanfengyue
// @homepageURL  https://github.com/wguanfengyue/%E8%B6%85%E6%98%9F%E5%AD%A6%E4%B9%A0%E9%80%9A%E7%AD%BE%E5%88%B0%E5%8A%A9%E6%89%8B
// @supportURL   https://github.com/wguanfengyue/%E8%B6%85%E6%98%9F%E5%AD%A6%E4%B9%A0%E9%80%9A%E7%AD%BE%E5%88%B0%E5%8A%A9%E6%89%8B/issues
// @downloadURL  https://raw.githubusercontent.com/wguanfengyue/%E8%B6%85%E6%98%9F%E5%AD%A6%E4%B9%A0%E9%80%9A%E7%AD%BE%E5%88%B0%E5%8A%A9%E6%89%8B/main/signscript.user.js
// @updateURL    https://raw.githubusercontent.com/wguanfengyue/%E8%B6%85%E6%98%9F%E5%AD%A6%E4%B9%A0%E9%80%9A%E7%AD%BE%E5%88%B0%E5%8A%A9%E6%89%8B/main/signscript.user.js
// @match        *://chaoxing.com/*
// @match        *://*.chaoxing.com/*
// @connect      mooc1-api.chaoxing.com
// @connect      mobilelearn.chaoxing.com
// @connect      kb.chaoxing.com
// @connect      nominatim.openstreetmap.org
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const API = Object.freeze({
    courses: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata',
    activities: 'https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist',
    activityInfo: 'https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo',
    preSign: 'https://mobilelearn.chaoxing.com/newsign/preSign',
    ordinarySign: 'https://mobilelearn.chaoxing.com/v2/apis/sign/signIn',
    pptSign: 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax',
    timetable: 'https://kb.chaoxing.com/pc/curriculum/getMyLessons',
    geocode: 'https://nominatim.openstreetmap.org',
    login: 'https://i.chaoxing.com/'
  });

  const SUPPORTED_TYPES = Object.freeze({
    '0': '普通签到',
    '2': '二维码签到',
    '4': '位置签到'
  });

  class AppError extends Error {
    constructor(message, code = 'UNKNOWN') {
      super(message);
      this.name = 'AppError';
      this.code = code;
    }
  }

  function buildUrl(base, params = {}) {
    const result = new URL(base);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) result.searchParams.set(key, String(value));
    });
    return result.toString();
  }

  function parseJson(text, context) {
    const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!cleaned || cleaned[0] === '<') {
      throw new AppError(`${context}返回了登录页或网页，登录状态可能已失效。`, 'LOGIN_REQUIRED');
    }
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      throw new AppError(`${context}返回的数据格式已经变化。`, 'API_CHANGED');
    }
  }

  function validId(value, label) {
    const id = String(value == null ? '' : value);
    if (!/^\d+$/.test(id)) throw new AppError(`${label}缺少有效 ID。`, 'API_CHANGED');
    return id;
  }

  function parseCourses(text) {
    const root = parseJson(text, '课程接口');
    if (String(root.result) !== '1') {
      throw new AppError('没有读取到课程。请确认已在超星网页登录，然后再试。', 'LOGIN_REQUIRED');
    }
    if (!Array.isArray(root.channelList)) {
      throw new AppError('课程列表格式已经变化。', 'API_CHANGED');
    }
    const courses = [];
    root.channelList.forEach((channel) => {
      const content = channel && channel.content;
      const data = content && content.course && content.course.data;
      if (!Array.isArray(data)) return;
      data.forEach((course) => {
        courses.push({
          id: validId(course && course.id, '课程'),
          classId: validId(content.id, '班级'),
          name: String((course && course.name) || '未命名课程')
        });
      });
    });
    return courses;
  }

  function parseActivities(text, course) {
    const root = parseJson(text, `“${course.name}”活动接口`);
    if (root.result != null && String(root.result) !== '1') {
      throw new AppError(`“${course.name}”的活动查询失败。`, 'QUERY_FAILED');
    }
    const data = root && root.data;
    const list = data && data.activeList;
    if (!Array.isArray(list)) {
      throw new AppError(`“${course.name}”的活动列表格式已经变化。`, 'API_CHANGED');
    }
    const ext = data.ext == null
      ? ''
      : (typeof data.ext === 'string' ? data.ext : JSON.stringify(data.ext));
    return list
      .filter((item) => item && String(item.status) === '1' && SUPPORTED_TYPES[String(item.otherId)])
      .map((item) => ({
        id: validId(item.id, '活动'),
        type: String(item.otherId),
        typeName: SUPPORTED_TYPES[String(item.otherId)],
        name: String(item.nameOne || item.name || item.activeName || '未命名签到'),
        ext,
        course
      }));
  }

  function parseCoordinate(input) {
    const parts = String(input || '').trim().replace(/，/g, ',').split(',');
    if (parts.length !== 2) throw new AppError('坐标格式应为“经度,纬度”。', 'INVALID_INPUT');
    const longitude = Number(parts[0].trim());
    const latitude = Number(parts[1].trim());
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
        Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
      throw new AppError('经度范围为 -180～180，纬度范围为 -90～90。', 'INVALID_INPUT');
    }
    return { longitude: String(longitude), latitude: String(latitude) };
  }

  function parseEnc(input) {
    let value = String(input || '').trim();
    if (/^SIGNIN:/i.test(value)) {
      throw new AppError('这是新版 SIGNIN 二维码，当前脚本不支持，请使用官方客户端。', 'UNSUPPORTED_QR');
    }
    if (/^https?:\/\//i.test(value)) {
      let parsed;
      try { parsed = new URL(value); } catch (error) {
        throw new AppError('二维码链接格式无效。', 'INVALID_INPUT');
      }
      value = parsed.searchParams.get('enc') || '';
    }
    if (!/^[0-9a-f]{32}$/i.test(value)) {
      throw new AppError('没有找到有效的 32 位 enc；请粘贴当前二维码链接。', 'INVALID_INPUT');
    }
    return value;
  }

  function interpretSignResponse(text) {
    const cleaned = String(text || '').trim();
    if (cleaned === 'success') return { ok: true, message: '签到成功，服务器返回 success。' };
    if (/^locationAuthError(?:_|$)/i.test(cleaned)) {
      const code = cleaned.split('_')[1] || '未知错误码';
      return {
        ok: false,
        message: `位置授权链校验未通过（${code}）。这不是通常的“超出范围”响应，请改用超星官方定位流程。`
      };
    }
    if (cleaned[0] === '{') {
      try {
        const data = JSON.parse(cleaned);
        if (String(data.result) === '1' || data.status === true || data.success === true) {
          return { ok: true, message: String(data.msg || data.message || '签到成功。') };
        }
        return { ok: false, message: String(data.msg || data.message || '服务器没有确认签到成功。') };
      } catch (error) { /* Fall through to an unknown response. */ }
    }
    const safe = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 240);
    return { ok: false, message: `服务器没有确认签到成功${safe ? `：${safe}` : '。'}` };
  }

  function request(method, endpoint, params = {}) {
    const url = method === 'GET' ? buildUrl(endpoint, params) : endpoint;
    const isGeocode = endpoint.startsWith(API.geocode);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        data: method === 'POST' ? new URLSearchParams(params).toString() : undefined,
        headers: {
          Accept: 'application/json, text/plain, */*',
          ...(isGeocode ? {
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'User-Agent': 'signscript-userscript/3.5.0',
            'X-Requested-With': 'signscript-userscript-3.5.0'
          } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {})
        },
        timeout: 15000,
        anonymous: isGeocode,
        withCredentials: !isGeocode,
        onload(response) {
          const finalUrl = String(response.finalUrl || url);
          if (/passport|login/i.test(finalUrl) && !/mobilelearn\.chaoxing\.com\/newsign/i.test(finalUrl)) {
            reject(new AppError('登录状态已失效，请重新登录超星。', 'LOGIN_REQUIRED'));
          } else if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText || '');
          } else if ([401, 403].includes(response.status)) {
            reject(isGeocode
              ? new AppError('地图地址服务拒绝了请求，请稍后重试。', 'GEOCODE_FAILED')
              : new AppError('登录状态已失效，请重新登录超星。', 'LOGIN_REQUIRED'));
          } else {
            reject(new AppError(`${isGeocode ? '地图地址服务' : '接口'}返回 HTTP ${response.status}。`, 'HTTP_ERROR'));
          }
        },
        ontimeout() { reject(new AppError(`${isGeocode ? '地图地址服务' : '连接'}超时，请稍后重试。`, 'TIMEOUT')); },
        onerror() { reject(new AppError(isGeocode ? '地图地址服务连接失败，请检查跨域权限。' : '网络请求失败，请检查网络或油猴的跨域权限。', 'NETWORK')); }
      });
    });
  }

  const geocodeCache = new Map();
  let geocodeQueue = Promise.resolve();
  let lastGeocodeAt = 0;

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function geocode(path, params) {
    const key = `${path}:${JSON.stringify(params)}`;
    if (geocodeCache.has(key)) return geocodeCache.get(key);
    const run = async () => {
      const remaining = 1100 - (Date.now() - lastGeocodeAt);
      if (remaining > 0) await delay(remaining);
      lastGeocodeAt = Date.now();
      let data;
      try {
        data = JSON.parse(await request('GET', `${API.geocode}/${path}`, params));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('地图地址服务返回了无法识别的数据。', 'GEOCODE_FAILED');
      }
      geocodeCache.set(key, data);
      return data;
    };
    const result = geocodeQueue.then(run);
    geocodeQueue = result.catch(() => undefined);
    return result;
  }

  function clampLatitude(latitude) {
    return Math.max(-85.05112878, Math.min(85.05112878, latitude));
  }

  function latLonToWorld(latitude, longitude, zoom) {
    const size = 256 * Math.pow(2, zoom);
    const lat = clampLatitude(latitude) * Math.PI / 180;
    return {
      x: (longitude + 180) / 360 * size,
      y: (0.5 - Math.log((1 + Math.sin(lat)) / (1 - Math.sin(lat))) / (4 * Math.PI)) * size
    };
  }

  function worldToLatLon(x, y, zoom) {
    const size = 256 * Math.pow(2, zoom);
    const longitude = x / size * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / size;
    return {
      longitude: ((longitude + 540) % 360) - 180,
      latitude: clampLatitude(180 / Math.PI * Math.atan(Math.sinh(n)))
    };
  }

  const WEEKDAY_NAMES = Object.freeze(['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']);

  function normalizeClock(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match || Number(match[1]) > 23) return '';
    return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
  }

  function clockToMinutes(value) {
    const normalized = normalizeClock(value);
    if (!normalized) return NaN;
    const [hour, minute] = normalized.split(':').map(Number);
    return hour * 60 + minute;
  }

  function pickLessonTimes(curriculum) {
    const week = String(curriculum.currentWeek || curriculum.realCurrentWeek || '');
    const weekly = Array.isArray(curriculum.weeksLessonTimeConfigArray)
      ? curriculum.weeksLessonTimeConfigArray.find((item) => String(item.weeks || '').split(',').includes(week))
      : null;
    if (weekly && Array.isArray(weekly.timeConfig)) return weekly.timeConfig;
    return Array.isArray(curriculum.lessonTimeConfigArray) ? curriculum.lessonTimeConfigArray : [];
  }

  function parseTimetable(text) {
    const root = parseJson(text, '课表接口');
    if (String(root.result) !== '1' || !root.data || !root.data.curriculum) {
      throw new AppError(root.msg || '没有读取到首页课表，请确认登录状态。', 'TIMETABLE_FAILED');
    }
    const curriculum = root.data.curriculum;
    const lessonTimes = pickLessonTimes(curriculum);
    const earlySections = Number(curriculum.earlyMorningSection) || 0;
    const groups = new Map();
    const lessons = Array.isArray(root.data.lessonArray) ? root.data.lessonArray : [];
    lessons.forEach((lesson) => {
      const day = Number(lesson.dayOfWeek);
      const begin = Number(lesson.beginNumber) + earlySections - 1;
      const length = Number(lesson.length);
      if (!Number.isInteger(day) || day < 1 || day > 7 || !Number.isInteger(begin) || !Number.isInteger(length) || length < 1) return;
      const firstRange = String(lessonTimes[begin] || '');
      const lastRange = String(lessonTimes[begin + length - 1] || '');
      let start = normalizeClock(firstRange.split('-')[0]);
      let end = normalizeClock(lastRange.split('-')[1]);
      if (lesson.extendInfo && lesson.extendInfo.startTime && lesson.extendInfo.endTime) {
        start = normalizeClock(String(lesson.extendInfo.startTime).split(' ')[1]?.slice(0, 5)) || start;
        end = normalizeClock(String(lesson.extendInfo.endTime).split(' ')[1]?.slice(0, 5)) || end;
      }
      if (!start || !end) return;
      const id = String(lesson.courseId == null ? '' : lesson.courseId);
      const classId = String(lesson.classId == null ? '' : lesson.classId);
      const monitorable = /^\d+$/.test(id) && /^\d+$/.test(classId) && id !== '0' && classId !== '0';
      const offlineKey = String(lesson.courseNo || lesson.classNo || lesson.name || '未命名课程');
      const key = monitorable ? `${id}:${classId}` : `offline:${offlineKey}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          id,
          classId,
          name: String(lesson.name || '未命名课程'),
          monitorable,
          slots: []
        });
      }
      const course = groups.get(key);
      const slot = { day, start, end, location: String(lesson.location || '') };
      if (!course.slots.some((item) => item.day === day && item.start === start && item.end === end)) {
        course.slots.push(slot);
      }
    });
    const courses = Array.from(groups.values());
    courses.forEach((course) => course.slots.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)));
    courses.sort((a, b) => Number(b.monitorable) - Number(a.monitorable) || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      schoolYear: String(curriculum.schoolYear || ''),
      semester: String(curriculum.semester || ''),
      currentWeek: Number(curriculum.currentWeek || curriculum.realCurrentWeek || 0),
      courses
    };
  }

  function parseActivityInfo(text) {
    const root = parseJson(text, '签到详情接口');
    if (String(root.result) !== '1' || !root.data) {
      throw new AppError(root.msg || '没有读取到签到详情。', 'QUERY_FAILED');
    }
    return root.data;
  }

  function formatSignClock(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function ensureActivityOpen(info, fallbackNow = Date.now()) {
    const serverNow = Number(info && info.nowTime);
    const now = Number.isFinite(serverNow) && serverNow > 0 ? serverNow : Number(fallbackNow);
    const start = Number(info && info.starttime);
    const normalEnd = Number(info && info.endtime);
    const lateEnd = Number(info && info.lateEndTime);
    const end = Number.isFinite(lateEnd) && lateEnd > normalEnd ? lateEnd : normalEnd;
    if (Number.isFinite(start) && start > 0 && now < start) {
      throw new AppError(`该签到将在 ${formatSignClock(start)} 开始，现在还不能提交。`, 'NOT_STARTED');
    }
    if (Number.isFinite(end) && end > 0 && now > end) {
      throw new AppError(`该签到已于 ${formatSignClock(end)} 结束。`, 'ENDED');
    }
    return info;
  }

  function officialSignUrl(activity) {
    return buildUrl(API.preSign, {
      courseId: activity.course.id,
      classId: activity.course.classId,
      activePrimaryId: activity.id,
      general: 1,
      sys: 1,
      ls: 1,
      appType: 15,
      isTeacherViewOpen: 0
    });
  }

  function flagEnabled(info, ...keys) {
    return keys.some((key) => ['1', 'true'].includes(String(info && info[key]).toLowerCase()));
  }

  function describeActivityRequirements(info) {
    const requirements = [];
    if (flagEnabled(info, 'openCheckFaceFlag')) requirements.push('人脸识别');
    if (flagEnabled(info, 'ifNeedVCode', 'showVCode')) requirements.push('验证码');
    if (flagEnabled(info, 'ifphoto')) requirements.push('现场照片');
    if (flagEnabled(info, 'openPreventCheatFlag')) requirements.push('防作弊校验');
    if (flagEnabled(info, 'openCheckWeChatFlag')) requirements.push('微信校验');
    const locationText = String((info && info.locationText) || '').trim();
    const locationRange = Number(info && info.locationRange);
    const location = locationText
      ? `要求位置：${locationText}${Number.isFinite(locationRange) && locationRange > 0 ? `（${locationRange} 米范围）` : ''}`
      : '服务器未公开固定中心点或范围';
    return `${location}。${requirements.length ? `附加校验：${requirements.join('、')}。` : '未发现公开的验证码、人脸或防作弊标记。'}位置授权仍由超星官方流程完成。`;
  }

  function openOfficialSign(activity) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = officialSignUrl(activity);
    form.target = '_blank';
    form.style.display = 'none';
    const ext = document.createElement('input');
    ext.type = 'hidden';
    ext.name = 'ext';
    ext.value = activity.ext || '';
    form.append(ext);
    document.documentElement.append(form);
    form.submit();
    form.remove();
  }

  function timetableWindowAt(weekMinute, courses, beforeMinutes, afterMinutes) {
    const current = Number(weekMinute);
    const activeKeys = new Set();
    const descriptions = [];
    let nextStart = Infinity;
    (courses || []).forEach((course) => {
      (course.slots || []).forEach((slot) => {
        const baseDay = (Number(slot.day) - 1) * 1440;
        [
          { label: '上课', minute: clockToMinutes(slot.start) },
          { label: '下课', minute: clockToMinutes(slot.end) }
        ].forEach((boundary) => {
          if (!Number.isFinite(boundary.minute)) return;
          [-1, 0, 1].forEach((weekOffset) => {
            const center = baseDay + boundary.minute + weekOffset * 10080;
            const start = center - beforeMinutes;
            const end = center + afterMinutes;
            if (current >= start && current <= end) {
              activeKeys.add(course.key);
              descriptions.push(`${course.name} · ${WEEKDAY_NAMES[slot.day]} ${slot.start} ${boundary.label}`);
            } else if (start > current) {
              nextStart = Math.min(nextStart, start);
            }
          });
        });
      });
    });
    return activeKeys.size
      ? {
          active: true,
          courses: (courses || []).filter((course) => activeKeys.has(course.key)),
          descriptions: Array.from(new Set(descriptions))
        }
      : { active: false, minutesUntilStart: nextStart - current };
  }

  async function mapWithLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
      while (next < items.length) {
        const index = next++;
        try { results[index] = { status: 'fulfilled', value: await worker(items[index]) }; }
        catch (reason) { results[index] = { status: 'rejected', reason }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  async function loadActivities() {
    const courseText = await request('GET', API.courses, { view: 'json', mcode: '' });
    const courses = parseCourses(courseText);
    const responses = await mapWithLimit(courses, 4, async (course) => {
      const text = await request('GET', API.activities, {
        fid: -1,
        courseId: course.id,
        classId: course.classId,
        showNotStartedActive: 0
      });
      return parseActivities(text, course);
    });
    const activities = [];
    const warnings = [];
    responses.forEach((response, index) => {
      if (response.status === 'fulfilled') activities.push(...response.value);
      else warnings.push(`${courses[index].name}：${response.reason.message || '查询失败'}`);
    });
    if (courses.length && warnings.length === courses.length) {
      const loginError = responses.find((item) => item.reason && item.reason.code === 'LOGIN_REQUIRED');
      if (loginError) throw loginError.reason;
      throw new AppError('所有课程的活动查询都失败了，请稍后重试。', 'QUERY_FAILED');
    }
    return { activities, courseCount: courses.length, warnings };
  }

  async function fetchTimetable() {
    const text = await request('GET', API.timetable, { curTime: Date.now() });
    return { ...parseTimetable(text), fetchedAt: Date.now() };
  }

  async function loadScheduledActivities(courses) {
    const responses = await mapWithLimit(courses, 2, async (course) => {
      const text = await request('GET', API.activities, {
        fid: -1,
        courseId: course.id,
        classId: course.classId,
        showNotStartedActive: 0
      });
      return parseActivities(text, course);
    });
    const activities = [];
    const warnings = [];
    responses.forEach((response, index) => {
      if (response.status === 'fulfilled') activities.push(...response.value);
      else warnings.push(`${courses[index].name}：${response.reason.message || '查询失败'}`);
    });
    if (courses.length && warnings.length === courses.length) throw responses[0].reason;
    return { activities, courseCount: courses.length, warnings };
  }

  async function submitSign(activity, fields) {
    const info = parseActivityInfo(await request('GET', API.activityInfo, { activeId: activity.id }));
    ensureActivityOpen(info);
    if (activity.type === '0') {
      return interpretSignResponse(await request('GET', API.ordinarySign, { activeId: activity.id }));
    }
    if (activity.type === '4') {
      throw new AppError('位置签到需要超星官方定位授权，请使用“打开超星官方签到页”。', 'OFFICIAL_LOCATION_REQUIRED');
    }
    await request('POST', officialSignUrl(activity), { ext: activity.ext || '' });
    return interpretSignResponse(await request('GET', API.pptSign, {
      enc: fields.enc,
      name: fields.name,
      activeId: activity.id,
      clientip: '',
      useragent: '',
      latitude: -1,
      longitude: -1,
      appType: 15
    }));
  }

  // Pure functions are exposed only to the local test runner, never in normal page use.
  if (globalThis.__SIGNSCRIPT_TEST_MODE__) {
    globalThis.__SIGNSCRIPT_TEST_API__ = {
      buildUrl, parseJson, parseCourses, parseActivities, parseCoordinate,
      parseEnc, interpretSignResponse, mapWithLimit, latLonToWorld, worldToLatLon,
      parseTimetable, timetableWindowAt, normalizeClock, parseActivityInfo, ensureActivityOpen,
      officialSignUrl, describeActivityRequirements
    };
    return;
  }

  const state = {
    open: false,
    busy: false,
    loaded: false,
    filter: 'all',
    activities: [],
    warnings: [],
    signed: new Set(),
    selected: null
  };

  const mapState = {
    latitude: 35.8617,
    longitude: 104.1954,
    zoom: 4,
    address: '',
    drag: null,
    reverseSequence: 0,
    renderFrame: 0
  };

  const DEFAULT_SCHEDULE = Object.freeze({
    enabled: false,
    selectedCourses: [],
    beforeMinutes: 10,
    afterMinutes: 10,
    intervalSeconds: 5
  });

  function storedScheduleConfig() {
    const saved = GM_getValue('scheduleSettings', {}) || {};
    const selectedCourses = Array.isArray(saved.selectedCourses)
      ? saved.selectedCourses.filter((course) => course && course.monitorable !== false && /^\d+:\d+$/.test(String(course.key || '')))
      : [];
    const integer = (value, fallback, minimum, maximum) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
    };
    return {
      enabled: Boolean(saved.enabled && selectedCourses.length),
      selectedCourses,
      beforeMinutes: integer(saved.beforeMinutes, DEFAULT_SCHEDULE.beforeMinutes, 0, 60),
      afterMinutes: integer(saved.afterMinutes, DEFAULT_SCHEDULE.afterMinutes, 0, 60),
      intervalSeconds: integer(saved.intervalSeconds, DEFAULT_SCHEDULE.intervalSeconds, 5, 300)
    };
  }

  const monitorState = {
    config: storedScheduleConfig(),
    timer: 0,
    failures: 0,
    knownIds: new Set(),
    lastCheckedAt: 0,
    timetable: (() => {
      const cached = GM_getValue('timetableCache', null);
      return cached && Array.isArray(cached.courses) ? cached : null;
    })(),
    syncing: null,
    lastSyncAttempt: 0,
    choiceMap: new Map()
  };

  const $ = {};
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setStatus(message, kind = 'neutral') {
    $.status.textContent = message;
    $.status.dataset.kind = kind;
  }

  function setBusy(value, message) {
    state.busy = value;
    $.refresh.disabled = value;
    $.panel.dataset.busy = String(value);
    if (message) setStatus(message, 'loading');
  }

  function friendlyError(error, submission = false) {
    const message = error && error.message ? error.message : '发生未知错误。';
    return submission
      ? `${message} 本次结果尚未确认，请先到官方客户端核对记录，避免重复提交。`
      : message;
  }

  function renderEmpty(message, action) {
    $.list.replaceChildren();
    const empty = element('div', 'ss-empty');
    empty.append(element('div', 'ss-empty-icon', '◎'), element('p', '', message));
    if (action) empty.append(action);
    $.list.append(empty);
  }

  function renderList() {
    $.list.replaceChildren();
    if (!state.loaded) {
      const button = element('button', 'ss-primary', '读取当前账号的签到活动');
      button.addEventListener('click', refresh);
      renderEmpty('先在超星网页登录，再读取活动。脚本不会读取或显示 Cookie。', button);
      return;
    }
    const visible = state.activities.filter((activity) => state.filter === 'all' || activity.type === state.filter);
    $.summary.textContent = `找到 ${state.activities.length} 个进行中的受支持签到`;
    if (!visible.length) {
      renderEmpty(state.activities.length ? '当前筛选下没有活动。' : '暂未发现普通、位置或旧版二维码签到。');
      return;
    }
    visible.forEach((activity) => {
      const card = element('article', 'ss-card');
      const top = element('div', 'ss-card-top');
      const badge = element('span', `ss-badge ss-type-${activity.type}`, activity.typeName);
      const id = element('span', 'ss-id', `活动 ${activity.id}`);
      top.append(badge, id);
      const course = element('h3', '', activity.course.name);
      const name = element('p', 'ss-activity-name', activity.name);
      const buttonLabel = activity.type === '4' ? '查看要求并打开官方签到' : '填写并核对';
      const button = element('button', 'ss-primary', state.signed.has(activity.id) ? '本次已完成' : buttonLabel);
      button.disabled = state.busy || state.signed.has(activity.id);
      button.addEventListener('click', () => openForm(activity));
      card.append(top, course, name, button);
      $.list.append(card);
    });
  }

  function showLoginAction() {
    const button = element('button', 'ss-primary', '打开超星登录页');
    button.addEventListener('click', () => GM_openInTab(API.login, { active: true, insert: true }));
    renderEmpty('没有读取到登录状态。请打开登录页完成登录，再回到这里刷新。', button);
  }

  async function refresh() {
    if (state.busy) return;
    setBusy(true, '正在读取课程和活动…');
    $.summary.textContent = '请求会复用浏览器登录态';
    try {
      const result = await loadActivities();
      state.activities = result.activities;
      result.activities.forEach((activity) => monitorState.knownIds.add(activity.id));
      state.warnings = result.warnings;
      state.loaded = true;
      setStatus('已连接', 'success');
      $.summary.textContent = `已检查 ${result.courseCount} 门课程`;
      renderList();
      if (result.warnings.length) showToast(`有 ${result.warnings.length} 门课程查询失败，其余结果已显示。`, 'warning');
    } catch (error) {
      state.loaded = false;
      setStatus(error.code === 'LOGIN_REQUIRED' ? '需要登录' : '读取失败', 'error');
      $.summary.textContent = friendlyError(error);
      if (error.code === 'LOGIN_REQUIRED') showLoginAction();
      else {
        const button = element('button', 'ss-secondary', '重新读取');
        button.addEventListener('click', refresh);
        renderEmpty(friendlyError(error), button);
      }
    } finally {
      setBusy(false);
      if (state.loaded) renderList();
    }
  }

  function selectedCoursesForCurrentWeek() {
    if (!monitorState.timetable) return [];
    const selected = new Set(monitorState.config.selectedCourses.map((course) => course.key));
    return monitorState.timetable.courses.filter((course) => course.monitorable && selected.has(course.key));
  }

  function monitorWindowNow() {
    const now = new Date();
    const weekday = now.getDay() || 7;
    const weekMinute = (weekday - 1) * 1440 + now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    return timetableWindowAt(
      weekMinute,
      selectedCoursesForCurrentWeek(),
      monitorState.config.beforeMinutes,
      monitorState.config.afterMinutes
    );
  }

  function formatClock(date) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function setMonitorBanner(message, kind = 'neutral') {
    $.monitorBanner.hidden = !message;
    $.monitorBanner.textContent = message;
    $.monitorBanner.dataset.kind = kind;
  }

  function courseSlotText(course) {
    if (!course.slots || !course.slots.length) return '本周没有排课';
    return course.slots
      .map((slot) => `${WEEKDAY_NAMES[slot.day]} ${slot.start}–${slot.end}${slot.location ? ` · ${slot.location}` : ''}`)
      .join('；');
  }

  function renderScheduleCourses() {
    if (!$.scheduleCourses) return;
    const selectedMap = new Map(monitorState.config.selectedCourses.map((course) => [course.key, course]));
    const currentCourses = monitorState.timetable ? monitorState.timetable.courses : [];
    const displayMap = new Map(currentCourses.map((course) => [course.key, course]));
    monitorState.config.selectedCourses.forEach((course) => {
      if (!displayMap.has(course.key)) displayMap.set(course.key, { ...course, monitorable: true, slots: [] });
    });
    const courses = Array.from(displayMap.values());
    monitorState.choiceMap = new Map(courses.map((course) => [course.key, course]));
    $.scheduleCourses.replaceChildren();
    if (!courses.length) {
      $.scheduleCourses.append(element('div', 'ss-map-result-note', '尚未读取到课表，请点击“重新读取课表”。'));
    } else {
      courses.forEach((course) => {
        const label = element('label', `ss-course-choice${course.monitorable ? '' : ' ss-course-disabled'}`);
        const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = course.key;
        checkbox.checked = selectedMap.has(course.key);
        checkbox.disabled = !course.monitorable;
        const details = element('span', 'ss-course-details');
        details.append(
          element('strong', '', course.name),
          element('small', '', course.monitorable ? courseSlotText(course) : `${courseSlotText(course)} · 未绑定超星网络课程，无法查询签到`)
        );
        label.append(checkbox, details);
        $.scheduleCourses.append(label);
      });
    }
    if ($.scheduleMeta) {
      const table = monitorState.timetable;
      $.scheduleMeta.textContent = table
        ? `${table.schoolYear}-${Number(table.schoolYear || 0) + 1} 第 ${table.semester} 学期 · 第 ${table.currentWeek} 周`
        : '尚未同步首页课表';
    }
  }

  async function syncTimetable(force = false) {
    const fresh = monitorState.timetable && Date.now() - Number(monitorState.timetable.fetchedAt || 0) < 6 * 60 * 60 * 1000;
    if (!force && fresh) return monitorState.timetable;
    if (monitorState.syncing) return monitorState.syncing;
    monitorState.lastSyncAttempt = Date.now();
    monitorState.syncing = (async () => {
      if ($.scheduleLoad) {
        $.scheduleLoad.disabled = true;
        $.scheduleLoad.textContent = '读取中…';
      }
      try {
        const timetable = await fetchTimetable();
        monitorState.timetable = timetable;
        GM_setValue('timetableCache', timetable);
        renderScheduleCourses();
        if ($.scheduleOverlay && !$.scheduleOverlay.hidden) setScheduleError();
        return timetable;
      } finally {
        if ($.scheduleLoad) {
          $.scheduleLoad.disabled = false;
          $.scheduleLoad.textContent = '重新读取课表';
        }
      }
    })();
    try { return await monitorState.syncing; }
    finally { monitorState.syncing = null; }
  }

  function notifyNewActivities(activities) {
    if (!activities.length) return;
    const first = activities[0];
    const extra = activities.length > 1 ? `，另有 ${activities.length - 1} 个` : '';
    const message = `${first.course.name}：${first.name}（${first.typeName}）${extra}`;
    $.launcher.dataset.alert = 'true';
    setStatus('发现新签到', 'success');
    setMonitorBanner(`发现新签到 · ${formatClock(new Date())}`, 'success');
    showToast(message, 'success');
    if (typeof GM_notification === 'function') {
      GM_notification({
        title: '学习通：发现新的签到活动',
        text: message,
        timeout: 15000,
        onclick() {
          globalThis.focus();
          toggle(true);
        }
      });
    }
  }

  async function runScheduledRefresh(windowState) {
    const existingIds = new Set([
      ...monitorState.knownIds,
      ...state.activities.map((activity) => activity.id)
    ]);
    setBusy(true);
    setMonitorBanner(`${windowState.descriptions[0] || '课表时段'} · 检测中…`, 'loading');
    try {
      const result = await loadScheduledActivities(windowState.courses);
      const newActivities = result.activities.filter((activity) => !existingIds.has(activity.id));
      state.activities = result.activities;
      state.warnings = result.warnings;
      state.loaded = true;
      result.activities.forEach((activity) => monitorState.knownIds.add(activity.id));
      monitorState.failures = 0;
      monitorState.lastCheckedAt = Date.now();
      if (newActivities.length) notifyNewActivities(newActivities);
      else {
        setStatus('定时检测中', 'loading');
        setMonitorBanner(`${windowState.descriptions[0] || '课表时段'} · 最近检查 ${formatClock(new Date())}`);
      }
    } catch (error) {
      monitorState.failures += 1;
      setStatus(error.code === 'LOGIN_REQUIRED' ? '需要登录' : '检测重试中', 'error');
      setMonitorBanner(`${friendlyError(error)} 将自动退避重试。`, 'error');
    } finally {
      setBusy(false);
      if (state.loaded) renderList();
    }
  }

  function queueMonitor(milliseconds) {
    clearTimeout(monitorState.timer);
    monitorState.timer = setTimeout(monitorTick, Math.max(250, milliseconds));
  }

  async function monitorTick() {
    clearTimeout(monitorState.timer);
    if (!monitorState.config.enabled) {
      setMonitorBanner('');
      return;
    }
    const stale = !monitorState.timetable || Date.now() - Number(monitorState.timetable.fetchedAt || 0) >= 6 * 60 * 60 * 1000;
    if (stale && Date.now() - monitorState.lastSyncAttempt >= 60000) {
      try { await syncTimetable(false); }
      catch (error) {
        setMonitorBanner(`${friendlyError(error)} 课表将在一分钟后重新同步。`, 'error');
        queueMonitor(60000);
        return;
      }
    }
    const selectedCourses = selectedCoursesForCurrentWeek();
    if (!selectedCourses.length) {
      setMonitorBanner('定时检测已开启 · 本周所选课程没有可检测的课表时段');
      queueMonitor(30000);
      return;
    }
    const windowState = monitorWindowNow();
    if (!windowState.active) {
      const minutes = Math.max(0, Math.ceil(windowState.minutesUntilStart));
      const waitText = minutes < 120 ? `${minutes} 分钟` : minutes < 2880 ? `${Math.ceil(minutes / 60)} 小时` : `${Math.ceil(minutes / 1440)} 天`;
      setMonitorBanner(`课表检测已开启 · 约 ${waitText}后进入下一检测窗口`);
      monitorState.failures = 0;
      queueMonitor(Math.min(30000, Math.max(1000, windowState.minutesUntilStart * 60000)));
      return;
    }
    if (state.busy) {
      setMonitorBanner('课表检测窗口内 · 等待当前操作完成', 'loading');
      queueMonitor(1000);
      return;
    }
    const startedAt = Date.now();
    await runScheduledRefresh(windowState);
    const baseDelay = monitorState.config.intervalSeconds * 1000;
    const failureDelay = monitorState.failures
      ? Math.min(60000, baseDelay * Math.pow(2, monitorState.failures))
      : baseDelay;
    queueMonitor(Math.max(500, failureDelay - (Date.now() - startedAt)));
  }

  function restartMonitor() {
    clearTimeout(monitorState.timer);
    monitorState.failures = 0;
    queueMonitor(300);
  }

  function setScheduleError(message = '') {
    $.scheduleError.textContent = message;
    $.scheduleError.hidden = !message;
  }

  function openScheduleSettings() {
    const config = monitorState.config;
    $.scheduleEnabled.checked = config.enabled;
    $.scheduleBefore.value = String(config.beforeMinutes);
    $.scheduleAfter.value = String(config.afterMinutes);
    $.scheduleInterval.value = String(config.intervalSeconds);
    setScheduleError();
    $.scheduleOverlay.hidden = false;
    renderScheduleCourses();
    syncTimetable(true).catch((error) => setScheduleError(friendlyError(error)));
  }

  function closeScheduleSettings() {
    $.scheduleOverlay.hidden = true;
    setScheduleError();
  }

  function saveScheduleSettings() {
    try {
      const readInteger = (node, label, minimum, maximum) => {
        const value = Number(node.value);
        if (!Number.isInteger(value) || value < minimum || value > maximum) {
          throw new AppError(`${label}应为 ${minimum}～${maximum} 的整数。`, 'INVALID_INPUT');
        }
        return value;
      };
      const selectedCourses = Array.from($.scheduleCourses.querySelectorAll('input:checked'))
        .map((node) => monitorState.choiceMap.get(node.value))
        .filter(Boolean)
        .map((course) => ({ key: course.key, id: course.id, classId: course.classId, name: course.name, monitorable: true }));
      const config = {
        enabled: $.scheduleEnabled.checked,
        selectedCourses,
        beforeMinutes: readInteger($.scheduleBefore, '提前时间', 0, 60),
        afterMinutes: readInteger($.scheduleAfter, '延后时间', 0, 60),
        intervalSeconds: readInteger($.scheduleInterval, '刷新间隔', 5, 300)
      };
      if (config.enabled && !config.selectedCourses.length) {
        throw new AppError('启用定时检测前，请至少选择一门可检测课程。', 'INVALID_INPUT');
      }
      GM_setValue('scheduleSettings', config);
      monitorState.config = config;
      closeScheduleSettings();
      restartMonitor();
      showToast(config.enabled ? '课表定时检测已开启。请保持超星页面打开。' : '定时检测已关闭。', 'success');
    } catch (error) {
      setScheduleError(error.message || '定时设置保存失败。');
    }
  }

  function labeledInput(label, input) {
    const wrapper = element('label', 'ss-field');
    wrapper.append(element('span', '', label), input);
    return wrapper;
  }

  function input(name, placeholder, value = '') {
    const node = element('input', 'ss-input');
    node.name = name;
    node.placeholder = placeholder;
    node.value = value;
    node.autocomplete = 'off';
    return node;
  }

  function setFormError(message = '') {
    $.formError.textContent = message;
    $.formError.hidden = !message;
  }

  function openForm(activity) {
    state.selected = activity;
    setFormError();
    $.formTitle.textContent = `${activity.typeName} · ${activity.course.name}`;
    $.formSubtitle.textContent = `${activity.name} · 活动 ${activity.id}`;
    $.fields.replaceChildren();
    const saved = GM_getValue('profile', {}) || {};
    const preset = GM_getValue('locationPreset', {}) || {};
    if (activity.type === '4') {
      const requirement = element('p', 'ss-form-note', '正在读取服务器公开的签到要求…');
      $.fields.append(
        requirement,
        element('p', 'ss-form-note', '位置签到会在新标签页进入超星官方流程，由超星读取当前账号、定位权限和活动授权。本脚本不会把预设坐标伪装成设备定位。')
      );
      if (preset.longitude != null && preset.latitude != null) {
        $.fields.append(element('div', 'ss-preset-hint', `本机保存的位置“${preset.label || preset.address || '常用位置'}”仅供地图核对，不会代替官方定位。`));
      }
      request('GET', API.activityInfo, { activeId: activity.id })
        .then((text) => {
          if (state.selected !== activity) return;
          activity.info = parseActivityInfo(text);
          requirement.textContent = describeActivityRequirements(activity.info);
        })
        .catch((error) => {
          if (state.selected === activity) requirement.textContent = `暂时无法读取公开要求：${error.message || '接口失败'}。仍可打开官方签到页。`;
        });
    } else if (activity.type === '2') {
      $.fields.append(
        labeledInput('当前二维码链接或 enc', input('enc', '粘贴二维码解码后的链接')),
        labeledInput('姓名', input('name', '服务器显示的姓名', saved.name || ''))
      );
    } else {
      $.fields.append(element('p', 'ss-form-note', '普通签到不需要填写额外信息，请继续核对。'));
    }
    $.rememberRow.hidden = activity.type === '0' || activity.type === '4';
    $.remember.checked = Boolean(saved.name || saved.address);
    $.submit.textContent = activity.type === '4' ? '打开超星官方签到页' : '核对提交内容';
    $.form.hidden = false;
    $.panel.classList.add('ss-form-open');
    const first = $.fields.querySelector('input');
    if (first) first.focus();
  }

  function closeForm() {
    $.form.hidden = true;
    $.panel.classList.remove('ss-form-open');
    state.selected = null;
    setFormError();
  }

  function setSettingsError(message = '') {
    $.settingsError.textContent = message;
    $.settingsError.hidden = !message;
  }

  function openLocationSettings() {
    const preset = GM_getValue('locationPreset', {}) || {};
    $.settingsLabel.value = preset.label || '';
    $.settingsAddress.value = preset.address || '';
    $.settingsCoordinate.value = preset.longitude != null && preset.latitude != null
      ? `${preset.longitude},${preset.latitude}` : '';
    setSettingsError();
    $.settingsOverlay.hidden = false;
    $.settingsLabel.focus();
  }

  function closeLocationSettings() {
    $.settingsOverlay.hidden = true;
    setSettingsError();
  }

  function saveLocationSettings() {
    try {
      const coordinate = parseCoordinate($.settingsCoordinate.value);
      const address = $.settingsAddress.value.trim();
      if (!address) throw new AppError('请填写签到时显示的地址。', 'INVALID_INPUT');
      GM_setValue('locationPreset', {
        label: $.settingsLabel.value.trim() || '常用位置',
        address,
        longitude: coordinate.longitude,
        latitude: coordinate.latitude
      });
      closeLocationSettings();
      showToast('常用位置已保存在本机，位置签到时会自动填入。', 'success');
    } catch (error) {
      setSettingsError(error.message || '位置保存失败。');
    }
  }

  function clearLocationSettings() {
    GM_deleteValue('locationPreset');
    $.settingsLabel.value = '';
    $.settingsAddress.value = '';
    $.settingsCoordinate.value = '';
    closeLocationSettings();
    showToast('已清除常用位置。');
  }

  function setMapStatus(message, kind = 'neutral') {
    $.mapStatus.textContent = message;
    $.mapStatus.dataset.kind = kind;
  }

  function scheduleMapRender() {
    if (mapState.renderFrame) return;
    mapState.renderFrame = requestAnimationFrame(() => {
      mapState.renderFrame = 0;
      renderMap();
    });
  }

  function renderMap() {
    const rect = $.mapCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const zoom = mapState.zoom;
    const tileCount = Math.pow(2, zoom);
    const center = latLonToWorld(mapState.latitude, mapState.longitude, zoom);
    const left = center.x - rect.width / 2;
    const top = center.y - rect.height / 2;
    const firstX = Math.floor(left / 256);
    const lastX = Math.floor((left + rect.width) / 256);
    const firstY = Math.max(0, Math.floor(top / 256));
    const lastY = Math.min(tileCount - 1, Math.floor((top + rect.height) / 256));
    const fragment = document.createDocumentFragment();
    for (let tileY = firstY; tileY <= lastY; tileY += 1) {
      for (let tileX = firstX; tileX <= lastX; tileX += 1) {
        const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
        const image = element('img', 'ss-map-tile');
        image.alt = '';
        image.draggable = false;
        image.referrerPolicy = 'origin';
        image.src = `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`;
        image.style.left = `${tileX * 256 - left}px`;
        image.style.top = `${tileY * 256 - top}px`;
        fragment.append(image);
      }
    }
    $.mapTiles.replaceChildren(fragment);
    $.mapCoordinate.textContent = `${mapState.longitude.toFixed(6)}, ${mapState.latitude.toFixed(6)} · z${zoom}`;
  }

  function setMapCenter(latitude, longitude, zoom = mapState.zoom) {
    mapState.latitude = clampLatitude(Number(latitude));
    mapState.longitude = ((Number(longitude) + 540) % 360) - 180;
    mapState.zoom = Math.max(3, Math.min(19, Number(zoom)));
    scheduleMapRender();
  }

  function openMapPicker() {
    let initial;
    try { initial = parseCoordinate($.settingsCoordinate.value); }
    catch (error) { initial = null; }
    if (initial) {
      setMapCenter(Number(initial.latitude), Number(initial.longitude), 17);
      mapState.address = $.settingsAddress.value.trim();
    } else {
      const preset = GM_getValue('locationPreset', {}) || {};
      if (preset.longitude != null && preset.latitude != null) {
        setMapCenter(Number(preset.latitude), Number(preset.longitude), 17);
        mapState.address = preset.address || '';
      } else {
        setMapCenter(35.8617, 104.1954, 4);
        mapState.address = '';
      }
    }
    $.mapSearch.value = '';
    $.mapResults.replaceChildren();
    $.mapAddress.textContent = mapState.address || '拖动地图或搜索地点，再点击目标位置。';
    setMapStatus('地图使用 WGS84 坐标');
    $.mapOverlay.hidden = false;
    requestAnimationFrame(renderMap);
  }

  function closeMapPicker() {
    $.mapOverlay.hidden = true;
    mapState.drag = null;
  }

  async function reverseSelected() {
    const sequence = ++mapState.reverseSequence;
    mapState.address = '';
    $.mapAddress.textContent = '正在获取选点地址…';
    setMapStatus('正在查询地址…', 'loading');
    try {
      const data = await geocode('reverse', {
        format: 'jsonv2',
        lat: mapState.latitude.toFixed(6),
        lon: mapState.longitude.toFixed(6),
        zoom: 18,
        addressdetails: 1,
        'accept-language': 'zh-CN'
      });
      if (sequence !== mapState.reverseSequence) return;
      if (!data || !data.display_name) throw new AppError('这个位置没有可用的地址数据。', 'NO_ADDRESS');
      mapState.address = String(data.display_name);
      $.mapAddress.textContent = mapState.address;
      setMapStatus('地址已获取', 'success');
    } catch (error) {
      if (sequence !== mapState.reverseSequence) return;
      $.mapAddress.textContent = '地址获取失败，可继续使用坐标并手动填写显示地址。';
      setMapStatus(error.message || '地址服务暂时不可用', 'error');
    }
  }

  async function searchMap() {
    const query = $.mapSearch.value.trim();
    if (!query) { setMapStatus('请输入地点或地址。', 'error'); return; }
    $.mapSearchButton.disabled = true;
    $.mapResults.replaceChildren(element('div', 'ss-map-result-note', '正在搜索…'));
    setMapStatus('正在搜索…', 'loading');
    try {
      const data = await geocode('search', {
        format: 'jsonv2',
        q: query,
        limit: 5,
        addressdetails: 1,
        'accept-language': 'zh-CN'
      });
      if (!Array.isArray(data) || !data.length) {
        $.mapResults.replaceChildren(element('div', 'ss-map-result-note', '没有找到匹配地点，可换一个关键词。'));
        setMapStatus('未找到结果', 'error');
        return;
      }
      $.mapResults.replaceChildren();
      data.forEach((place) => {
        const button = element('button', 'ss-map-result', String(place.display_name || '未命名地点'));
        button.type = 'button';
        button.addEventListener('click', () => {
          setMapCenter(Number(place.lat), Number(place.lon), 17);
          mapState.address = String(place.display_name || '');
          $.mapAddress.textContent = mapState.address;
          $.mapResults.replaceChildren();
          setMapStatus('已选择搜索结果', 'success');
        });
        $.mapResults.append(button);
      });
      setMapStatus(`找到 ${data.length} 个结果`);
    } catch (error) {
      $.mapResults.replaceChildren(element('div', 'ss-map-result-note', error.message || '地点搜索失败。'));
      setMapStatus('搜索失败', 'error');
    } finally {
      $.mapSearchButton.disabled = false;
    }
  }

  function useMapSelection() {
    $.settingsCoordinate.value = `${mapState.longitude.toFixed(6)},${mapState.latitude.toFixed(6)}`;
    if (mapState.address) $.settingsAddress.value = mapState.address;
    closeMapPicker();
    setSettingsError(mapState.address ? '' : '已填入地图坐标，但未获取到地址，请手动填写显示地址。');
  }

  function locateOnMap(button) {
    if (!navigator.geolocation) { setMapStatus('当前浏览器不支持定位。', 'error'); return; }
    button.disabled = true;
    button.textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setMapCenter(position.coords.latitude, position.coords.longitude, 17);
        button.disabled = false;
        button.textContent = '我的位置';
        reverseSelected();
      },
      (error) => {
        const messages = { 1: '定位权限被拒绝。', 2: '暂时无法获取位置。', 3: '获取位置超时。' };
        setMapStatus(messages[error.code] || '获取位置失败。', 'error');
        button.disabled = false;
        button.textContent = '我的位置';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function bindMapInteraction() {
    $.mapCanvas.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button,a,input')) return;
      $.mapCanvas.setPointerCapture(event.pointerId);
      mapState.drag = {
        x: event.clientX,
        y: event.clientY,
        world: latLonToWorld(mapState.latitude, mapState.longitude, mapState.zoom),
        moved: false
      };
      $.mapCanvas.dataset.dragging = 'true';
    });
    $.mapCanvas.addEventListener('pointermove', (event) => {
      if (!mapState.drag) return;
      const dx = event.clientX - mapState.drag.x;
      const dy = event.clientY - mapState.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) mapState.drag.moved = true;
      const position = worldToLatLon(mapState.drag.world.x - dx, mapState.drag.world.y - dy, mapState.zoom);
      mapState.latitude = position.latitude;
      mapState.longitude = position.longitude;
      scheduleMapRender();
    });
    const finish = (event) => {
      if (!mapState.drag) return;
      if (!mapState.drag.moved) {
        const rect = $.mapCanvas.getBoundingClientRect();
        const center = latLonToWorld(mapState.latitude, mapState.longitude, mapState.zoom);
        const selected = worldToLatLon(
          center.x + event.clientX - rect.left - rect.width / 2,
          center.y + event.clientY - rect.top - rect.height / 2,
          mapState.zoom
        );
        mapState.latitude = selected.latitude;
        mapState.longitude = selected.longitude;
      }
      mapState.drag = null;
      $.mapCanvas.dataset.dragging = 'false';
      renderMap();
      reverseSelected();
    };
    $.mapCanvas.addEventListener('pointerup', finish);
    $.mapCanvas.addEventListener('pointercancel', () => {
      mapState.drag = null;
      $.mapCanvas.dataset.dragging = 'false';
    });
    $.mapCanvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      setMapCenter(mapState.latitude, mapState.longitude, mapState.zoom + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }

  function locateCurrent(coordinateInput, button, reportError = setFormError) {
    if (!navigator.geolocation) {
      reportError('当前浏览器不支持定位，请手动输入坐标。'); return;
    }
    button.disabled = true;
    button.textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        coordinateInput.value = `${position.coords.longitude.toFixed(6)},${position.coords.latitude.toFixed(6)}`;
        button.disabled = false; button.textContent = '重新定位'; reportError();
      },
      (error) => {
        const messages = { 1: '定位权限被拒绝，可在浏览器网站设置中允许定位。', 2: '暂时无法获取位置。', 3: '获取位置超时。' };
        reportError(messages[error.code] || '获取位置失败，请手动输入坐标。');
        button.disabled = false; button.textContent = '获取当前位置';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function collectFields(activity) {
    const value = (name) => {
      const node = $.fields.querySelector(`[name="${name}"]`);
      return node ? node.value.trim() : '';
    };
    if (activity.type === '0') return {};
    if (activity.type === '4') {
      throw new AppError('位置签到请使用超星官方定位流程。', 'OFFICIAL_LOCATION_REQUIRED');
    }
    const name = value('name');
    if (!name) throw new AppError('请填写姓名。', 'INVALID_INPUT');
    return { name, enc: parseEnc(value('enc')) };
  }

  function showReview(activity, fields) {
    return new Promise((resolve) => {
      $.reviewBody.replaceChildren();
      const rows = [
        ['课程', activity.course.name],
        ['活动', `${activity.name}（${activity.id}）`],
        ['类型', activity.typeName]
      ];
      if (fields.name) rows.push(['姓名', fields.name]);
      if (fields.address) rows.push(['地址', fields.address], ['坐标', `${fields.longitude}, ${fields.latitude}`]);
      if (fields.enc) rows.push(['二维码', `enc …${fields.enc.slice(-6)}`]);
      rows.forEach(([label, value]) => {
        const row = element('div', 'ss-review-row');
        row.append(element('span', '', label), element('strong', '', value));
        $.reviewBody.append(row);
      });
      function finish(value) {
        $.review.hidden = true;
        $.reviewConfirm.removeEventListener('click', yes);
        $.reviewCancel.removeEventListener('click', no);
        resolve(value);
      }
      const yes = () => finish(true);
      const no = () => finish(false);
      $.reviewConfirm.addEventListener('click', yes);
      $.reviewCancel.addEventListener('click', no);
      $.review.hidden = false;
      $.reviewCancel.focus();
    });
  }

  async function prepareSubmit() {
    if (state.busy || !state.selected) return;
    if (state.selected.type === '4') {
      try {
        if (state.selected.info) ensureActivityOpen(state.selected.info);
        openOfficialSign(state.selected);
        setStatus('已请求打开官方签到页', 'success');
        showToast('请在新标签页允许定位并按超星页面提示完成签到。', 'success');
      } catch (error) {
        setFormError(error.message || '无法打开官方签到页。');
      }
      return;
    }
    let fields;
    try { fields = collectFields(state.selected); }
    catch (error) { setFormError(error.message); return; }
    setFormError();
    const activity = state.selected;
    if (!await showReview(activity, fields)) return;
    if ($.remember.checked && fields.name) GM_setValue('profile', { name: fields.name, address: fields.address || '' });
    else GM_deleteValue('profile');
    setBusy(true, '正在提交…');
    $.submit.disabled = true;
    try {
      const result = await submitSign(activity, fields);
      if (result.ok) {
        state.signed.add(activity.id);
        closeForm();
        setStatus('签到成功', 'success');
        showToast(result.message, 'success');
      } else {
        setStatus('未确认成功', 'error');
        setFormError(`${result.message} 请在官方客户端核对记录。`);
      }
    } catch (error) {
      setStatus('结果未确认', 'error');
      setFormError(friendlyError(error, true));
    } finally {
      setBusy(false);
      $.submit.disabled = false;
      renderList();
    }
  }

  let toastTimer;
  function showToast(message, kind = 'neutral') {
    clearTimeout(toastTimer);
    $.toast.textContent = message;
    $.toast.dataset.kind = kind;
    $.toast.hidden = false;
    toastTimer = setTimeout(() => { $.toast.hidden = true; }, 5000);
  }

  function toggle(open = !state.open) {
    state.open = open;
    $.panel.hidden = !open;
    $.launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      delete $.launcher.dataset.alert;
      $.close.focus();
    }
  }

  function buildUi() {
    GM_addStyle(`
      #ss-root, #ss-root * { box-sizing: border-box; }
      #ss-root { --blue:#2563eb; --blue2:#1d4ed8; --ink:#172033; --muted:#687386; --line:#e5e9f0; --bg:#f7f9fc; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); }
      #ss-root button, #ss-root input, #ss-root select { font:inherit; }
      .ss-launcher { position:fixed; right:22px; bottom:24px; z-index:2147483645; border:0; border-radius:999px; padding:12px 17px; color:#fff; background:linear-gradient(135deg,var(--blue),#5b5ce2); box-shadow:0 12px 30px rgba(37,99,235,.3); cursor:pointer; font-weight:700; }
      .ss-launcher[data-alert="true"] { animation:ss-alert 1s ease-in-out infinite alternate; background:linear-gradient(135deg,#e5484d,#f97316); }
      @keyframes ss-alert { from { transform:scale(1); box-shadow:0 12px 30px rgba(229,72,77,.32); } to { transform:scale(1.07); box-shadow:0 14px 38px rgba(229,72,77,.55); } }
      .ss-panel { position:fixed; right:22px; bottom:82px; width:min(410px,calc(100vw - 24px)); max-height:min(720px,calc(100vh - 105px)); z-index:2147483646; background:#fff; border:1px solid rgba(30,50,90,.12); border-radius:18px; box-shadow:0 24px 70px rgba(15,23,42,.24); overflow:hidden; }
      .ss-panel[hidden], .ss-form[hidden], .ss-review[hidden], .ss-toast[hidden], .ss-error[hidden] { display:none!important; }
      .ss-header { display:flex; align-items:center; gap:10px; padding:16px 17px 13px; border-bottom:1px solid var(--line); }
      .ss-title { font-size:17px; font-weight:750; flex:1; }
      .ss-status { font-size:12px; padding:3px 8px; border-radius:999px; background:#eef2f7; color:var(--muted); }
      .ss-status[data-kind="success"] { background:#e9f9ef; color:#167345; } .ss-status[data-kind="error"] { background:#fff0f0; color:#b42318; } .ss-status[data-kind="loading"] { background:#edf4ff; color:#1d4ed8; }
      .ss-icon { border:0; background:transparent; color:#667085; cursor:pointer; font-size:20px; width:32px; height:32px; border-radius:8px; }
      .ss-icon:hover { background:#f0f3f7; }
      .ss-content { max-height:calc(min(720px,100vh - 105px) - 64px); overflow:auto; padding:15px; background:var(--bg); }
      .ss-toolbar { display:flex; gap:8px; align-items:center; margin-bottom:9px; }
      .ss-toolbar .ss-secondary { padding-left:10px; padding-right:10px; }
      .ss-select { flex:1; min-width:100px; border:1px solid var(--line); background:#fff; border-radius:10px; padding:8px 10px; color:var(--ink); }
      .ss-summary { color:var(--muted); font-size:13px; margin:0 0 11px; }
      .ss-monitor-banner { margin:0 0 10px; padding:8px 10px; border:1px solid #cfe0ff; border-radius:9px; background:#eef6ff; color:#245aa5; font-size:12px; overflow-wrap:anywhere; }
      .ss-monitor-banner[data-kind="success"] { border-color:#b9e6ca; background:#e9f9ef; color:#167345; }.ss-monitor-banner[data-kind="error"] { border-color:#facac7; background:#fff0f0; color:#a32820; }.ss-monitor-banner[data-kind="loading"] { color:#1d4ed8; }
      .ss-list { display:grid; gap:10px; }
      .ss-card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:13px; }
      .ss-card-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .ss-card h3 { font-size:15px; margin:10px 0 2px; overflow-wrap:anywhere; }
      .ss-activity-name { color:var(--muted); margin:0 0 11px; overflow-wrap:anywhere; }
      .ss-badge { font-size:12px; font-weight:700; border-radius:999px; padding:3px 8px; background:#eef2ff; color:#4338ca; }
      .ss-type-4 { background:#e9f9ef; color:#167345; } .ss-type-2 { background:#fff6dd; color:#8a5b00; }
      .ss-id { color:#98a2b3; font-size:11px; }
      .ss-primary, .ss-secondary { border-radius:10px; padding:8px 12px; cursor:pointer; font-weight:650; }
      .ss-primary { border:1px solid var(--blue); background:var(--blue); color:#fff; } .ss-primary:hover { background:var(--blue2); }
      .ss-secondary { border:1px solid #d8dee8; background:#fff; color:#344054; } .ss-secondary:hover { background:#f6f8fa; }
      .ss-primary:disabled, .ss-secondary:disabled { opacity:.55; cursor:not-allowed; }
      .ss-card .ss-primary { width:100%; }
      .ss-empty { text-align:center; background:#fff; border:1px dashed #d4dae4; border-radius:14px; padding:28px 18px; color:var(--muted); }
      .ss-empty-icon { font-size:28px; color:#98a2b3; }.ss-empty p { margin:7px 0 14px; }
      .ss-warning { background:#fff8e7; color:#785b13; border:1px solid #f3df9d; padding:10px 12px; border-radius:10px; margin-bottom:10px; font-size:12px; }
      .ss-form { position:absolute; inset:64px 0 0; z-index:2; background:var(--bg); padding:15px; overflow:auto; }
      .ss-form-head { display:flex; gap:9px; align-items:flex-start; margin-bottom:13px; }.ss-form-head div { flex:1; }
      .ss-form h2 { font-size:16px; margin:0 0 2px; }.ss-form-subtitle { color:var(--muted); font-size:12px; margin:0; }
      .ss-fields { display:grid; gap:11px; }.ss-field { display:grid; gap:5px; color:#344054; font-weight:650; }.ss-field span { font-size:13px; }
      .ss-input { width:100%; border:1px solid #d5dbe5; border-radius:10px; padding:10px 11px; color:var(--ink); background:#fff; outline:none; }.ss-input:focus { border-color:#6b8cef; box-shadow:0 0 0 3px rgba(37,99,235,.12); }
      .ss-location-row { display:grid; grid-template-columns:1fr auto; align-items:end; gap:8px; }.ss-location-row .ss-secondary { margin-bottom:0; height:42px; }
      .ss-location-actions { display:flex; gap:8px; }
      .ss-preset-hint { margin-bottom:-4px; padding:8px 10px; border-radius:9px; background:#eef6ff; color:#245aa5; font-size:12px; }
      .ss-form-note { background:#fff; border:1px solid var(--line); padding:13px; border-radius:10px; color:var(--muted); margin:0; }
      .ss-remember { display:flex; gap:8px; align-items:flex-start; color:var(--muted); font-size:12px; margin:13px 0; }.ss-remember input { margin-top:3px; }
      .ss-error { background:#fff0f0; color:#a32820; border:1px solid #facac7; border-radius:10px; padding:10px 12px; margin:12px 0; white-space:pre-wrap; }
      .ss-form-actions { display:flex; gap:9px; margin-top:13px; }.ss-form-actions button { flex:1; }
      .ss-review { position:fixed; inset:0; z-index:2147483647; background:rgba(15,23,42,.42); display:grid; place-items:center; padding:16px; }
      .ss-review-box { width:min(390px,100%); background:#fff; border-radius:16px; padding:18px; box-shadow:0 20px 60px rgba(0,0,0,.3); }.ss-review-box h2 { margin:0 0 4px; font-size:18px; }.ss-review-hint { color:var(--muted); margin:0 0 14px; }
      .ss-review-row { display:grid; grid-template-columns:68px 1fr; gap:9px; border-top:1px solid var(--line); padding:9px 0; }.ss-review-row span { color:var(--muted); }.ss-review-row strong { overflow-wrap:anywhere; }
      .ss-review-actions { display:flex; gap:9px; margin-top:14px; }.ss-review-actions button { flex:1; }
      .ss-schedule-check { display:flex; align-items:flex-start; gap:9px; margin:2px 0 13px; padding:10px 11px; border:1px solid var(--line); border-radius:10px; background:#f7f9fc; color:#344054; }
      .ss-schedule-check input { margin-top:4px; }
      .ss-schedule-box { width:min(560px,100%); max-height:calc(100vh - 32px); overflow:auto; }
      .ss-schedule-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 8px; }
      .ss-schedule-meta { color:var(--muted); font-size:12px; }
      .ss-schedule-courses { display:grid; gap:7px; max-height:270px; overflow:auto; padding:2px; }
      .ss-course-choice { display:flex; align-items:flex-start; gap:9px; padding:9px 10px; border:1px solid var(--line); border-radius:10px; background:#fff; cursor:pointer; }
      .ss-course-choice:has(input:checked) { border-color:#8babf4; background:#f2f6ff; }
      .ss-course-choice input { margin-top:4px; }
      .ss-course-details { display:grid; gap:2px; min-width:0; }.ss-course-details strong { color:#27364c; }.ss-course-details small { color:var(--muted); line-height:1.45; overflow-wrap:anywhere; }
      .ss-course-disabled { background:#f7f8fa; cursor:not-allowed; opacity:.72; }
      .ss-schedule-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
      .ss-schedule-note { margin:12px 0 0; color:var(--muted); font-size:12px; }
      .ss-map-box { width:min(760px,100%); max-height:calc(100vh - 32px); overflow:auto; }
      .ss-map-privacy { margin:0 0 12px; padding:9px 11px; border-radius:9px; background:#fff8e7; color:#785b13; font-size:12px; }
      .ss-map-search-row { display:grid; grid-template-columns:1fr auto; gap:8px; }
      .ss-map-search-row .ss-secondary { min-width:76px; }
      .ss-map-results { display:grid; gap:6px; margin-top:7px; max-height:138px; overflow:auto; }
      .ss-map-result { border:1px solid var(--line); border-radius:9px; padding:8px 10px; background:#fff; color:#344054; text-align:left; cursor:pointer; }
      .ss-map-result:hover { border-color:#9bb2ed; background:#f6f9ff; }
      .ss-map-result-note { padding:7px 2px; color:var(--muted); font-size:12px; }
      .ss-map-canvas { position:relative; height:360px; margin-top:11px; overflow:hidden; border:1px solid #cfd7e4; border-radius:12px; background:#e7edf3; cursor:grab; touch-action:none; user-select:none; }
      .ss-map-canvas[data-dragging="true"] { cursor:grabbing; }
      .ss-map-tiles { position:absolute; inset:0; overflow:hidden; }
      .ss-map-tile { position:absolute; width:256px; height:256px; max-width:none!important; user-select:none; pointer-events:none; }
      .ss-map-pin { position:absolute; z-index:2; left:50%; top:50%; width:22px; height:22px; border:3px solid #fff; border-radius:50% 50% 50% 0; background:#e5484d; box-shadow:0 2px 8px rgba(15,23,42,.38); transform:translate(-50%,-100%) rotate(-45deg); pointer-events:none; }
      .ss-map-pin::after { content:""; position:absolute; inset:5px; border-radius:50%; background:#fff; }
      .ss-map-zoom { position:absolute; z-index:3; top:10px; left:10px; display:grid; overflow:hidden; border:1px solid #cfd7e4; border-radius:9px; box-shadow:0 2px 8px rgba(15,23,42,.15); }
      .ss-map-zoom button { width:34px; height:34px; border:0; background:#fff; color:#27364c; cursor:pointer; font-size:20px; line-height:1; }
      .ss-map-zoom button + button { border-top:1px solid #d8dee8; }
      .ss-map-locate { position:absolute; z-index:3; top:10px; right:10px; border:1px solid #cfd7e4!important; box-shadow:0 2px 8px rgba(15,23,42,.15); }
      .ss-map-coordinate { position:absolute; z-index:3; left:10px; bottom:10px; padding:4px 7px; border-radius:6px; background:rgba(255,255,255,.92); color:#344054; box-shadow:0 1px 4px rgba(15,23,42,.18); font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; pointer-events:none; }
      .ss-map-attribution { position:absolute; z-index:3; right:5px; bottom:4px; padding:2px 4px; border-radius:4px; background:rgba(255,255,255,.86); color:#245aa5; font-size:10px; text-decoration:none; }
      .ss-map-address { min-height:45px; margin-top:9px; padding:9px 11px; border:1px solid var(--line); border-radius:9px; background:#f7f9fc; color:#344054; overflow-wrap:anywhere; }
      .ss-map-status { display:block; margin-top:6px; color:var(--muted); font-size:12px; }.ss-map-status[data-kind="success"] { color:#167345; }.ss-map-status[data-kind="error"] { color:#b42318; }.ss-map-status[data-kind="loading"] { color:#1d4ed8; }
      .ss-toast { position:fixed; z-index:2147483647; right:24px; top:24px; max-width:min(390px,calc(100vw - 48px)); padding:12px 15px; background:#182230; color:#fff; border-radius:11px; box-shadow:0 12px 35px rgba(0,0,0,.25); }.ss-toast[data-kind="success"] { background:#147a49; }.ss-toast[data-kind="warning"] { background:#875d09; }
      @media (max-width:520px) { .ss-panel { right:12px; bottom:72px; }.ss-launcher { right:12px; bottom:14px; }.ss-toolbar { flex-wrap:wrap; }.ss-select { flex-basis:100%; }.ss-location-row { grid-template-columns:1fr; }.ss-location-row .ss-secondary { height:auto; }.ss-location-actions button { flex:1; }.ss-schedule-grid { grid-template-columns:1fr; }.ss-map-canvas { height:300px; }.ss-map-coordinate { max-width:calc(100% - 20px); bottom:27px; } }
    `);

    const root = element('div'); root.id = 'ss-root';
    $.launcher = element('button', 'ss-launcher', '签到助手');
    $.launcher.setAttribute('aria-expanded', 'false');
    $.launcher.addEventListener('click', () => toggle());

    $.panel = element('section', 'ss-panel'); $.panel.hidden = true;
    const header = element('header', 'ss-header');
    header.append(element('div', 'ss-title', '学习通签到助手'));
    $.status = element('span', 'ss-status', '尚未检查'); $.status.dataset.kind = 'neutral';
    $.close = element('button', 'ss-icon', '×'); $.close.title = '关闭'; $.close.addEventListener('click', () => toggle(false));
    header.append($.status, $.close);

    const content = element('div', 'ss-content');
    const notice = element('div', 'ss-warning', '脚本复用浏览器登录态，不读取或保存 Cookie。位置签到进入超星官方定位流程；验证码、新版 SIGNIN 二维码及其他额外校验请按官方页面提示完成。');
    const toolbar = element('div', 'ss-toolbar');
    $.filter = element('select', 'ss-select');
    [['all', '全部类型'], ['4', '位置签到'], ['0', '普通签到'], ['2', '二维码签到']].forEach(([value, text]) => {
      const option = element('option', '', text); option.value = value; $.filter.append(option);
    });
    $.filter.addEventListener('change', () => { state.filter = $.filter.value; renderList(); });
    $.settings = element('button', 'ss-secondary', '位置地图'); $.settings.addEventListener('click', openLocationSettings);
    $.scheduleSettings = element('button', 'ss-secondary', '定时检测'); $.scheduleSettings.addEventListener('click', openScheduleSettings);
    $.refresh = element('button', 'ss-secondary', '刷新'); $.refresh.addEventListener('click', refresh);
    toolbar.append($.filter, $.settings, $.scheduleSettings, $.refresh);
    $.summary = element('p', 'ss-summary', '尚未读取活动');
    $.monitorBanner = element('div', 'ss-monitor-banner'); $.monitorBanner.hidden = true; $.monitorBanner.dataset.kind = 'neutral';
    $.list = element('div', 'ss-list');
    content.append(notice, toolbar, $.summary, $.monitorBanner, $.list);

    $.form = element('section', 'ss-form'); $.form.hidden = true;
    const formHead = element('div', 'ss-form-head');
    const back = element('button', 'ss-icon', '←'); back.title = '返回活动列表'; back.addEventListener('click', closeForm);
    const titles = element('div'); $.formTitle = element('h2'); $.formSubtitle = element('p', 'ss-form-subtitle'); titles.append($.formTitle, $.formSubtitle); formHead.append(back, titles);
    $.fields = element('div', 'ss-fields');
    $.rememberRow = element('label', 'ss-remember'); $.remember = element('input'); $.remember.type = 'checkbox';
    $.rememberRow.append($.remember, element('span', '', '仅在本机保存姓名和地址，方便下次填写；不保存坐标、二维码或 Cookie。'));
    $.formError = element('div', 'ss-error'); $.formError.hidden = true;
    const formActions = element('div', 'ss-form-actions');
    const cancel = element('button', 'ss-secondary', '返回列表'); cancel.addEventListener('click', closeForm);
    $.submit = element('button', 'ss-primary', '核对提交内容'); $.submit.addEventListener('click', prepareSubmit);
    formActions.append(cancel, $.submit);
    $.form.append(formHead, $.fields, $.rememberRow, $.formError, formActions);
    $.panel.append(header, content, $.form);

    $.review = element('div', 'ss-review'); $.review.hidden = true;
    const reviewBox = element('div', 'ss-review-box'); reviewBox.setAttribute('role', 'dialog'); reviewBox.setAttribute('aria-modal', 'true');
    reviewBox.append(element('h2', '', '确认提交签到'), element('p', 'ss-review-hint', '请检查信息。提交后不要立即重复操作。'));
    $.reviewBody = element('div');
    const reviewActions = element('div', 'ss-review-actions');
    $.reviewCancel = element('button', 'ss-secondary', '返回修改');
    $.reviewConfirm = element('button', 'ss-primary', '确认提交');
    reviewActions.append($.reviewCancel, $.reviewConfirm); reviewBox.append($.reviewBody, reviewActions); $.review.append(reviewBox);

    $.settingsOverlay = element('div', 'ss-review ss-settings'); $.settingsOverlay.hidden = true;
    const settingsBox = element('div', 'ss-review-box'); settingsBox.setAttribute('role', 'dialog'); settingsBox.setAttribute('aria-modal', 'true');
    settingsBox.append(
      element('h2', '', '设置常用位置'),
      element('p', 'ss-review-hint', '仅保存在本机 Violentmonkey 中，用于地图核对；不会作为设备定位提交给超星。')
    );
    const settingsFields = element('div', 'ss-fields');
    $.settingsLabel = input('settingsLabel', '例如：第一教学楼');
    $.settingsCoordinate = input('settingsCoordinate', '例如：116.4,39.9');
    $.settingsAddress = input('settingsAddress', '签到时显示的文字地址');
    const settingsLocationRow = element('div', 'ss-location-row');
    const settingsLocate = element('button', 'ss-secondary', '获取当前位置'); settingsLocate.type = 'button';
    settingsLocate.addEventListener('click', () => locateCurrent(
      $.settingsCoordinate,
      settingsLocate,
      (message = '') => setSettingsError(message)
    ));
    const mapPick = element('button', 'ss-secondary', '地图选点'); mapPick.type = 'button';
    mapPick.addEventListener('click', openMapPicker);
    const settingsLocationActions = element('div', 'ss-location-actions');
    settingsLocationActions.append(settingsLocate, mapPick);
    settingsLocationRow.append(labeledInput('坐标（经度,纬度）', $.settingsCoordinate), settingsLocationActions);
    settingsFields.append(
      labeledInput('位置名称', $.settingsLabel),
      settingsLocationRow,
      labeledInput('显示地址', $.settingsAddress)
    );
    $.settingsError = element('div', 'ss-error'); $.settingsError.hidden = true;
    const settingsActions = element('div', 'ss-review-actions');
    const settingsClear = element('button', 'ss-secondary', '清除'); settingsClear.addEventListener('click', clearLocationSettings);
    const settingsCancel = element('button', 'ss-secondary', '取消'); settingsCancel.addEventListener('click', closeLocationSettings);
    const settingsSave = element('button', 'ss-primary', '保存位置'); settingsSave.addEventListener('click', saveLocationSettings);
    settingsActions.append(settingsClear, settingsCancel, settingsSave);
    settingsBox.append(settingsFields, $.settingsError, settingsActions);
    $.settingsOverlay.append(settingsBox);

    $.scheduleOverlay = element('div', 'ss-review ss-schedule-overlay'); $.scheduleOverlay.hidden = true;
    const scheduleBox = element('div', 'ss-review-box ss-schedule-box'); scheduleBox.setAttribute('role', 'dialog'); scheduleBox.setAttribute('aria-modal', 'true');
    scheduleBox.append(
      element('h2', '', '按课表定时检测'),
      element('p', 'ss-review-hint', '选择课程后，脚本会在每次上课和下课时间的前后窗口内检查该课程。')
    );
    const scheduleCheck = element('label', 'ss-schedule-check');
    $.scheduleEnabled = element('input'); $.scheduleEnabled.type = 'checkbox';
    scheduleCheck.append($.scheduleEnabled, element('span', '', '启用课表检测和系统通知'));
    const scheduleToolbar = element('div', 'ss-schedule-toolbar');
    $.scheduleMeta = element('span', 'ss-schedule-meta', '尚未同步首页课表');
    $.scheduleLoad = element('button', 'ss-secondary', '重新读取课表'); $.scheduleLoad.type = 'button';
    $.scheduleLoad.addEventListener('click', () => syncTimetable(true).catch((error) => setScheduleError(friendlyError(error))));
    scheduleToolbar.append($.scheduleMeta, $.scheduleLoad);
    $.scheduleCourses = element('div', 'ss-schedule-courses');
    $.scheduleBefore = input('scheduleBefore', '10'); $.scheduleBefore.type = 'number'; $.scheduleBefore.min = '0'; $.scheduleBefore.max = '60';
    $.scheduleAfter = input('scheduleAfter', '10'); $.scheduleAfter.type = 'number'; $.scheduleAfter.min = '0'; $.scheduleAfter.max = '60';
    $.scheduleInterval = input('scheduleInterval', '5'); $.scheduleInterval.type = 'number'; $.scheduleInterval.min = '5'; $.scheduleInterval.max = '300';
    const scheduleGrid = element('div', 'ss-schedule-grid');
    scheduleGrid.append(
      labeledInput('提前（分钟）', $.scheduleBefore),
      labeledInput('延后（分钟）', $.scheduleAfter),
      labeledInput('间隔（秒）', $.scheduleInterval)
    );
    const scheduleFields = element('div', 'ss-fields');
    scheduleFields.append(scheduleGrid);
    $.scheduleError = element('div', 'ss-error'); $.scheduleError.hidden = true;
    const scheduleNote = element('p', 'ss-schedule-note', '只会轮询已选择且已绑定超星网络课程的项目。请保持任意超星页面打开；后台标签页可能被 Chrome 降低定时器频率，电脑休眠期间不会检测。');
    const scheduleActions = element('div', 'ss-review-actions');
    const scheduleCancel = element('button', 'ss-secondary', '取消'); scheduleCancel.type = 'button'; scheduleCancel.addEventListener('click', closeScheduleSettings);
    const scheduleSave = element('button', 'ss-primary', '保存定时设置'); scheduleSave.type = 'button'; scheduleSave.addEventListener('click', saveScheduleSettings);
    scheduleActions.append(scheduleCancel, scheduleSave);
    scheduleBox.append(scheduleCheck, scheduleToolbar, $.scheduleCourses, scheduleFields, $.scheduleError, scheduleNote, scheduleActions);
    $.scheduleOverlay.append(scheduleBox);

    $.mapOverlay = element('div', 'ss-review ss-map-overlay'); $.mapOverlay.hidden = true;
    const mapBox = element('div', 'ss-review-box ss-map-box'); mapBox.setAttribute('role', 'dialog'); mapBox.setAttribute('aria-modal', 'true');
    mapBox.append(
      element('h2', '', '地图选点'),
      element('p', 'ss-review-hint', '搜索地点，或拖动地图让红色标记对准目标位置。点击地图也可直接选点。'),
      element('p', 'ss-map-privacy', '搜索文字和所选坐标会发送给 OpenStreetMap 地址服务，用于搜索及自动获取地址；点击“使用此位置”后才会回填到常用位置。')
    );
    const mapSearchRow = element('div', 'ss-map-search-row');
    $.mapSearch = input('mapSearch', '搜索学校、楼宇或详细地址');
    $.mapSearch.setAttribute('aria-label', '搜索地点');
    $.mapSearchButton = element('button', 'ss-secondary', '搜索'); $.mapSearchButton.type = 'button';
    $.mapSearchButton.addEventListener('click', searchMap);
    $.mapSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); searchMap(); }
    });
    mapSearchRow.append($.mapSearch, $.mapSearchButton);
    $.mapResults = element('div', 'ss-map-results');

    $.mapCanvas = element('div', 'ss-map-canvas'); $.mapCanvas.dataset.dragging = 'false';
    $.mapCanvas.setAttribute('role', 'application');
    $.mapCanvas.setAttribute('aria-label', '地图，拖动或点击选点');
    $.mapTiles = element('div', 'ss-map-tiles');
    const mapPin = element('div', 'ss-map-pin');
    const zoomControls = element('div', 'ss-map-zoom');
    const zoomIn = element('button', '', '+'); zoomIn.type = 'button'; zoomIn.title = '放大地图';
    zoomIn.addEventListener('click', () => setMapCenter(mapState.latitude, mapState.longitude, mapState.zoom + 1));
    const zoomOut = element('button', '', '−'); zoomOut.type = 'button'; zoomOut.title = '缩小地图';
    zoomOut.addEventListener('click', () => setMapCenter(mapState.latitude, mapState.longitude, mapState.zoom - 1));
    zoomControls.append(zoomIn, zoomOut);
    const mapLocate = element('button', 'ss-secondary ss-map-locate', '我的位置'); mapLocate.type = 'button';
    mapLocate.addEventListener('click', () => locateOnMap(mapLocate));
    $.mapCoordinate = element('span', 'ss-map-coordinate');
    const attribution = element('a', 'ss-map-attribution', '© OpenStreetMap contributors');
    attribution.href = 'https://www.openstreetmap.org/copyright'; attribution.target = '_blank'; attribution.rel = 'noopener noreferrer';
    $.mapCanvas.append($.mapTiles, mapPin, zoomControls, mapLocate, $.mapCoordinate, attribution);
    $.mapAddress = element('div', 'ss-map-address');
    $.mapStatus = element('span', 'ss-map-status'); $.mapStatus.dataset.kind = 'neutral';
    const mapActions = element('div', 'ss-review-actions');
    const mapCancel = element('button', 'ss-secondary', '取消'); mapCancel.type = 'button'; mapCancel.addEventListener('click', closeMapPicker);
    const mapUse = element('button', 'ss-primary', '使用此位置'); mapUse.type = 'button'; mapUse.addEventListener('click', useMapSelection);
    mapActions.append(mapCancel, mapUse);
    mapBox.append(mapSearchRow, $.mapResults, $.mapCanvas, $.mapAddress, $.mapStatus, mapActions);
    $.mapOverlay.append(mapBox);
    bindMapInteraction();

    $.toast = element('div', 'ss-toast'); $.toast.hidden = true;
    root.append($.launcher, $.panel, $.review, $.settingsOverlay, $.scheduleOverlay, $.mapOverlay, $.toast);
    document.documentElement.append(root);
    renderList();
  }

  buildUi();
  restartMonitor();
  GM_registerMenuCommand('打开学习通签到助手', () => toggle(true));
})();
