const { AsyncLocalStorage } = require("async_hooks");

// the request being handled ("CCD/20000"), so every log line written for it (Oracle calls, mails, ...) shows it
const context = new AsyncLocalStorage();

exports.run = (store, fn) => context.run(store, fn);

exports.reqId = () => context.getStore()?.reqId;
