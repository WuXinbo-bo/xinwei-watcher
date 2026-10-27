/* Shared URL parsing for the learning page in both the content script and service worker. */
(() => {
  'use strict';

  const SITE_ORIGIN = 'https://www.beeline-ai.com';
  const LEARN_ROUTE_FAMILIES = new Set(['courseInfo', 'shortCourse']);

  function parse(input) {
    let url;
    try {
      const value = typeof input === 'string' ? input : input?.url || input?.href;
      url = value instanceof URL ? value : new URL(value);
    } catch {
      return { type: 'other', courseKey: '' };
    }

    if (url.origin !== SITE_ORIGIN || url.username || url.password) {
      return { type: 'other', courseKey: '' };
    }
    if (url.pathname === '/stu/agent') return { type: 'agent', courseKey: '' };
    if (url.pathname === '/myBank/courseResearch' || url.pathname.startsWith('/myBank/courseResearch/')) {
      return { type: 'home', courseKey: '' };
    }
    if (!url.pathname.startsWith('/student/')) return { type: 'site', courseKey: '' };

    const hash = url.hash.replace(/^#/, '');
    const queryAt = hash.indexOf('?');
    const routePath = queryAt < 0 ? hash : hash.slice(0, queryAt);
    const segments = routePath.split('/').filter(Boolean);
    const marker = segments.findIndex((segment, index) =>
      segment === 'learn' && segments[index + 1] === 'courseWare');

    if (marker < 0) {
      const courseWareAt = segments.indexOf('courseWare');
      const looksLikeLearningPage = segments.includes('learn') || courseWareAt >= 0;
      const routeFamily = segments[0] || '';
      return looksLikeLearningPage
        ? { type: 'learn-unsupported', courseKey: '', routeFamily, reason: '学习页路由格式暂不支持' }
        : { type: 'site', courseKey: '', routeFamily };
    }

    const courseId = segments[marker + 2] || '';
    const routeFamily = segments[marker - 1] || '';
    if (!LEARN_ROUTE_FAMILIES.has(routeFamily)) {
      return { type: 'learn-unsupported', courseKey: '', routeFamily, reason: '学习页路由格式暂不支持' };
    }
    const hashQuery = queryAt < 0 ? '' : hash.slice(queryAt + 1);
    const classId = new URLSearchParams(hashQuery).get('classId') || '';
    if (!courseId || !classId) {
      return {
        type: 'learn-unsupported', courseKey: '', courseId, classId,
        reason: !courseId ? '课程页缺少课程标识' : '课程页缺少教学班标识'
      };
    }

    return {
      type: 'learn', courseId, classId, courseKey: `${courseId}::${classId}`,
      routeFamily
    };
  }

  globalThis.XinweiRoutes = Object.freeze({ SITE_ORIGIN, parse });
})();
