const fs = require("fs");
const path = require("path");

function createAuditLogStore(logFilePath) {
  const events = [];
  const resolvedPath = logFilePath || path.join(process.cwd(), "audit", "purchase-agent.jsonl");

  function append(event) {
    const entry = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    events.push(entry);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.appendFileSync(resolvedPath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  function list(filter = {}) {
    return events.filter((event) => {
      if (filter.userAddress && event.userAddress !== filter.userAddress) return false;
      if (filter.requestId && event.requestId !== filter.requestId) return false;
      if (filter.type && event.type !== filter.type) return false;
      if (filter.merchantId && event.merchantId !== filter.merchantId) return false;
      return true;
    });
  }

  return {
    append,
    list,
    get size() {
      return events.length;
    },
  };
}

module.exports = {
  createAuditLogStore,
};