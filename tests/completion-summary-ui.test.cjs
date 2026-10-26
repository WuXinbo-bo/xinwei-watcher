const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, homeFixture, mediaItem } = require('./helpers.cjs');

function setup() {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  const directory = f.api.getDirectorySnapshot(), key = f.api.currentCourseKey();
  f.api.state.tabId = 1;
  f.api.state.job = {runId:'summary',running:false,phase:'paused',scope:'all',targetIndex:0,targetPurpose:'play',
    candidates:[{key:'active',courseKey:key,title:'操作系统原理',status:'inspected',total:2,remaining:1,directory,
      records:{[directory.items[0].key]:{confirmed:true}}},
      {key:'done',title:'已完成课程',status:'complete',total:1,remaining:0,records:{}},
      {key:'manual',title:'待处理课程',status:'manual',records:{}},
      {key:'unknown',title:'未统计课程',status:'uninspected',records:{}}]};
  f.api.updateTaskControls();
  return Object.assign(f,{box:f.window.document.getElementById('wb-study-ui'),ui:f.api.state.uiController,job:f.api.state.job});
}

test('home distinguishes course completion, learning-item completion and target without task commands',()=>{
  const f=setup();
  try {
    let commands=0,clicks=0;
    f.window.chrome.runtime.sendMessage=async()=>{commands++;return {ok:true};};
    f.window.document.querySelector('.sub-menu-area').addEventListener('click',()=>clicks++);
    const summary=f.box.querySelector('#wb-home-summary'), local=f.box.querySelector('#wb-home-course-progress');
    assert.match(summary.textContent,/已完成 1 门.*待完成 3 门/s);
    assert.equal(summary.querySelector('[role=progressbar]').getAttribute('aria-valuenow'),'25');
    assert.match(local.textContent,/已完成 1 项 · 待完成 1 项/);
    assert.equal(local.querySelector('[role=progressbar]').getAttribute('aria-valuenow'),'50');
    summary.querySelector('[data-course-filter=pending]').click();
    assert.equal(f.ui.view,'courses');assert.equal(f.box.querySelectorAll('[data-course]').length,3);
    assert.equal(f.box.querySelector('[data-course=1]'),null);
    f.box.querySelector('[data-course-filter=complete]').click();
    assert.equal(f.box.querySelectorAll('[data-course]').length,1);
    f.box.querySelector('[data-course=1]').click();assert.equal(f.ui.view,'course');
    assert.match(f.box.querySelector('[data-view=course]').textContent,/已完成课程/);
    f.ui.navigate('home');f.box.querySelector('[data-current-directory]').click();
    assert.match(f.box.querySelector('[data-view=course]').textContent,/操作系统原理/);
    f.ui.navigate('home');f.box.querySelector('[data-current-directory]').click();assert.equal(f.ui.view,'course');
    f.ui.navigate('home');f.box.querySelector('[data-course-filter=attention]').click();
    assert.equal(f.box.querySelectorAll('[data-course]').length,1);assert.ok(f.box.querySelector('[data-course=2]'));
    assert.equal(commands,0);assert.equal(clicks,0);assert.equal(f.media.paused,true);
  } finally {f.window.close();}
});

test('scanning and unknown totals omit percentages; target reached does not confirm an item',()=>{
  const f=setup();
  try {
    f.job.phase='scan-home';f.ui.render();
    const summary=f.box.querySelector('#wb-home-summary');
    assert.match(summary.textContent,/扫描中.*已发现 4 门课程/s);assert.equal(summary.querySelector('#wb-home-task-progress [role=progressbar]'),null);
    const c=f.job.candidates[0];c.total=5;delete c.remaining;c.records={};
    c.records[c.directory.items[0].key]={targetReached:true,ended:true};
    f.ui.render();assert.match(f.box.querySelector('#wb-home-course-progress').textContent,/已完成 0 项 · 待完成 5 项/);
    delete c.total;c.directory=undefined;
    f.window.document.querySelector('.sub-menu-area').remove();f.ui.render();
    assert.match(f.box.querySelector('#wb-home-course-progress').textContent,/统计中/);
    assert.equal(f.box.querySelector('#wb-home-course-progress [role=progressbar]'),null);
  } finally {f.window.close();}
});

test('empty results do not claim 100 percent; completed courses use the confirmed count',()=>{
  const f=homeFixture([]);
  try {
    f.api.state.job={runId:'empty',running:false,phase:'finished',candidates:[]};f.api.updateTaskControls();
    const box=f.window.document.getElementById('wb-study-ui');
    assert.match(box.querySelector('#wb-home-summary').textContent,/共 0 门/);
    assert.equal(box.querySelector('#wb-home-summary [role=progressbar]'),null);
    assert.equal(box.querySelector('#wb-ui-directory').hidden,true);
    f.api.state.job.candidates=[{key:'a',title:'完成课',status:'complete',total:1,remaining:0}];f.api.updateTaskControls();
    assert.equal(box.querySelector('#wb-home-summary [role=progressbar]').getAttribute('aria-valuenow'),'100');
    box.querySelector('[data-course-filter=pending]').click();assert.match(box.querySelector('[data-view=courses]').textContent,/暂无符合此分类/);
    f.api.state.job={runId:'next',running:false,phase:'paused',candidates:[{key:'b',title:'新课程'}]};f.api.updateTaskControls();
    assert.ok(box.querySelector('[data-course=0]'),'a new task clears the old filter');
  } finally {f.window.close();}
});

test('a live course page outside the job does not inflate task course totals',()=>{
  const f=setup();
  try {
    f.job.candidates=[];f.job.phase='finished';f.ui.render();
    assert.match(f.box.querySelector('#wb-home-summary').textContent,/共 0 门/);
    assert.equal(f.box.querySelector('#wb-ui-directory').hidden,true);
    f.ui.navigate('courses');assert.equal(f.box.querySelector('[data-course]'),null);
  } finally {f.window.close();}
});
