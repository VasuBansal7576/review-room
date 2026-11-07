(function (root) {
  function connectionGuard(closePeers, delay = 30000, schedule = setTimeout, cancel = clearTimeout) {
    let timer;
    return {
      disconnected() {
        if (timer !== undefined) return;
        timer = schedule(() => { timer = undefined; closePeers(); }, delay);
      },
      connected() {
        if (timer !== undefined) cancel(timer);
        timer = undefined;
      },
      revoked() {
        if (timer !== undefined) cancel(timer);
        timer = undefined;
        closePeers();
      }
    };
  }
  if (typeof module !== 'undefined') module.exports = { connectionGuard };
  else root.connectionGuard = connectionGuard;
})(typeof window === 'undefined' ? globalThis : window);
