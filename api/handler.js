const handler = require('../vercel-backend/handler');

module.exports = (req, res) => {
  const original = new URL(req.url, 'https://review-room.invalid');
  if (original.pathname === '/api/handler') {
    const route = original.searchParams.get('rrpath');
    if (!route || !/^(?:api|recordings)\/[a-zA-Z0-9_/-]+$/.test(route)) {
      res.statusCode = 404;
      return res.end();
    }
    original.searchParams.delete('rrpath');
    req.url = `/${route}${original.search}`;
  }
  return handler(req, res);
};
