'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'signscript.user.js'), 'utf8');
const context = vm.createContext({
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
  __SIGNSCRIPT_TEST_MODE__: true
});
vm.runInContext(source, context, { filename: 'signscript.user.js' });
const api = context.__SIGNSCRIPT_TEST_API__;

function test(name, callback) {
  return Promise.resolve()
    .then(callback)
    .then(() => console.log(`✓ ${name}`));
}

async function main() {
  await test('查询参数正确编码', () => {
    const value = api.buildUrl('https://example.com/path', { name: '张三 & +', empty: '' });
    const parsed = new URL(value);
    assert.equal(parsed.searchParams.get('name'), '张三 & +');
    assert.equal(parsed.searchParams.get('empty'), '');
  });

  await test('课程 ID 不依赖固定长度', () => {
    const courses = api.parseCourses(JSON.stringify({
      result: 1,
      channelList: [
        { content: {} },
        { content: { id: 987654321012, course: { data: [{ id: 42, name: '测试课程' }] } } }
      ]
    }));
    assert.equal(courses.length, 1);
    assert.equal(courses[0].id, '42');
    assert.equal(courses[0].classId, '987654321012');
  });

  await test('登录页和异常课程响应会停止解析', () => {
    assert.throws(() => api.parseCourses('<html>login</html>'), /登录状态/);
    assert.throws(() => api.parseCourses('{"result":0}'), /网页登录/);
    assert.throws(() => api.parseCourses('{"result":1}'), /格式/);
  });

  await test('只保留进行中的受支持活动', () => {
    const activities = api.parseActivities(JSON.stringify({ data: { ext: { token: 'activity-context' }, activeList: [
      { id: 1000000000001, otherId: 4, status: 1, nameOne: '位置' },
      { id: 2, otherId: 2, status: 2 },
      { id: 3, otherId: 5, status: 1 }
    ] } }), { id: '1', classId: '2', name: '课程' });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].id, '1000000000001');
    assert.equal(activities[0].typeName, '位置签到');
    assert.equal(activities[0].ext, '{"token":"activity-context"}');
  });

  await test('位置坐标支持中文逗号并校验范围', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(api.parseCoordinate('116.4，39.9'))), {
      longitude: '116.4', latitude: '39.9'
    });
    ['NaN,1', 'Infinity,1', '181,0', '0,91', '1', '1,2,3'].forEach((value) => {
      assert.throws(() => api.parseCoordinate(value));
    });
  });

  await test('旧版二维码提取 enc，新版 SIGNIN 明确拒绝', () => {
    const enc = '0123456789abcdef0123456789abcdef';
    assert.equal(api.parseEnc(enc), enc);
    assert.equal(api.parseEnc(`https://example.com/sign?enc=${enc}&id=2`), enc);
    assert.throws(() => api.parseEnc('SIGNIN:aid=123&Code=x'), /不支持/);
    assert.throws(() => api.parseEnc('https://example.com/sign?aid=123'), /enc/);
  });

  await test('只有明确的成功响应才报告成功', () => {
    assert.equal(api.interpretSignResponse('success').ok, true);
    assert.equal(api.interpretSignResponse('{"result":1,"msg":"ok"}').ok, true);
    ['validate', 'successfully rejected', '{"result":0}', '<html>login</html>'].forEach((value) => {
      assert.equal(api.interpretSignResponse(value).ok, false);
    });
    assert.match(api.interpretSignResponse('locationAuthError_LCR007').message, /位置授权链校验未通过/);
  });

  await test('提交前按服务器时间拦截未开始和已结束的签到', () => {
    assert.throws(
      () => api.ensureActivityOpen({ nowTime: 1000, starttime: 2000, endtime: 3000 }),
      /还不能提交/
    );
    assert.throws(
      () => api.ensureActivityOpen({ nowTime: 4000, starttime: 1000, endtime: 3000 }),
      /已于/
    );
    assert.doesNotThrow(() => api.ensureActivityOpen({ nowTime: 2500, starttime: 2000, endtime: 3000 }));
    assert.doesNotThrow(() => api.ensureActivityOpen({ nowTime: 3500, starttime: 2000, endtime: 3000, lateEndTime: 4000 }));
  });

  await test('官方签到页带齐课程、班级和活动上下文', () => {
    const value = api.officialSignUrl({
      id: '7000000000000',
      course: { id: '123', classId: '456' }
    });
    const url = new URL(value);
    assert.equal(url.searchParams.get('courseId'), '123');
    assert.equal(url.searchParams.get('classId'), '456');
    assert.equal(url.searchParams.get('activePrimaryId'), '7000000000000');
    assert.equal(url.searchParams.get('appType'), '15');
    assert.equal(url.searchParams.get('isTeacherViewOpen'), '0');
  });

  await test('签到要求摘要识别人脸、验证码和位置范围', () => {
    const message = api.describeActivityRequirements({
      locationText: '第一教学楼', locationRange: 100,
      openCheckFaceFlag: 1, ifNeedVCode: true
    });
    assert.match(message, /第一教学楼/);
    assert.match(message, /100 米/);
    assert.match(message, /人脸识别/);
    assert.match(message, /验证码/);
  });

  await test('课程请求并发限制生效且保持顺序', async () => {
    let active = 0;
    let maximum = 0;
    const result = await api.mapWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return value * 2;
    });
    assert.equal(maximum, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(result.map((item) => item.value))), [2, 4, 6, 8, 10]);
  });

  await test('地图投影往返后保持经纬度', () => {
    [
      { latitude: 39.9042, longitude: 116.4074 },
      { latitude: -33.8688, longitude: 151.2093 },
      { latitude: 0, longitude: 0 }
    ].forEach((point) => {
      const world = api.latLonToWorld(point.latitude, point.longitude, 17);
      const restored = api.worldToLatLon(world.x, world.y, 17);
      assert.ok(Math.abs(restored.latitude - point.latitude) < 1e-8);
      assert.ok(Math.abs(restored.longitude - point.longitude) < 1e-8);
    });
  });

  await test('地图投影限制极区并处理经度跨界', () => {
    const world = api.latLonToWorld(90, 180, 4);
    const north = api.worldToLatLon(world.x, world.y, 4);
    assert.ok(north.latitude <= 85.05112878);
    assert.equal(north.longitude, -180);
  });

  await test('首页课表转换为可选择课程和本周上课时段', () => {
    const timetable = api.parseTimetable(JSON.stringify({
      result: 1,
      data: {
        curriculum: {
          schoolYear: '2026', semester: 1, currentWeek: 2, earlyMorningSection: 0,
          lessonTimeConfigArray: ['8:00-8:50', '9:00-9:50', '10:10-11:00', '11:10-12:00']
        },
        lessonArray: [
          { name: '计算机算法', beginNumber: 1, dayOfWeek: 5, length: 2, courseId: 123, classId: 456, location: 'A203' },
          { name: '线下课程', beginNumber: 3, dayOfWeek: 1, length: 2, courseId: 0, classId: 0, courseNo: 'OFFLINE-1' }
        ]
      }
    }));
    assert.equal(timetable.currentWeek, 2);
    assert.equal(timetable.courses.length, 2);
    assert.equal(timetable.courses[0].key, '123:456');
    assert.equal(timetable.courses[0].monitorable, true);
    assert.deepEqual(JSON.parse(JSON.stringify(timetable.courses[0].slots)), [
      { day: 5, start: '08:00', end: '09:50', location: 'A203' }
    ]);
    assert.equal(timetable.courses[1].monitorable, false);
  });

  await test('课表检测覆盖上下课边界并正确跨周', () => {
    const fridayCourse = {
      key: '123:456', name: '计算机算法', slots: [{ day: 5, start: '08:00', end: '09:50' }]
    };
    const minute = (day, hour, value) => (day - 1) * 1440 + hour * 60 + value;
    assert.equal(api.timetableWindowAt(minute(5, 7, 50), [fridayCourse], 10, 10).active, true);
    assert.equal(api.timetableWindowAt(minute(5, 8, 11), [fridayCourse], 10, 10).active, false);
    assert.equal(api.timetableWindowAt(minute(5, 9, 45), [fridayCourse], 10, 10).active, true);
    assert.equal(api.timetableWindowAt(minute(5, 10, 1), [fridayCourse], 10, 10).active, false);

    const mondayMidnight = {
      key: '9:10', name: '跨周课程', slots: [{ day: 1, start: '00:00', end: '00:50' }]
    };
    const sunday2355 = minute(7, 23, 55);
    const window = api.timetableWindowAt(sunday2355, [mondayMidnight], 10, 10);
    assert.equal(window.active, true);
    assert.equal(window.courses[0].key, '9:10');
  });

  console.log('\n15 项测试全部通过。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
