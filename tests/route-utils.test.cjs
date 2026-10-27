const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function parser() {
  const context = { URL, URLSearchParams, console };
  vm.runInNewContext(fs.readFileSync('route-utils.js', 'utf8'), context);
  return context.XinweiRoutes.parse;
}

test('课程页解析器兼容旧版和 shortCourse 路由并保持课程身份一致', () => {
  const parse = parser();
  for (const family of ['courseInfo', 'shortCourse']) {
    const result = parse(`https://www.beeline-ai.com/student/#/${family}/learn/courseWare/course-7/video/resource?classId=class-9`);
    assert.equal(result.type, 'learn');
    assert.equal(result.courseKey, 'course-7::class-9');
  }
});

test('课程解析器拒绝缺少教学班或跨站 URL，并返回可诊断类型', () => {
  const parse = parser();
  assert.equal(parse('https://www.beeline-ai.com/student/#/shortCourse/learn/courseWare/course-7/video/resource').type, 'learn-unsupported');
  assert.equal(parse('https://example.com/student/#/shortCourse/learn/courseWare/course-7/video/resource?classId=class-9').type, 'other');
  assert.equal(parse('https://www.beeline-ai.com/student/#/courseInfo/course/project/class').type, 'site');
  assert.equal(parse('https://www.beeline-ai.com/student/#/futureCourse/learn/courseWare/course-7/video/resource?classId=class-9').type, 'learn-unsupported');
});

test('Manifest 在内容脚本中先加载共享解析器，后台也提供同文件兜底加载', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('content.js')).js;
  assert.ok(scripts.indexOf('route-utils.js') < scripts.indexOf('content.js'));
  assert.match(fs.readFileSync('background.js', 'utf8'), /importScripts\('route-utils\.js'\)/);
});
