const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function createLoginRateLimit({
  windowMs = DEFAULT_WINDOW_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = Date.now,
} = {}) {
  const attemptsByIp = new Map();
  let nextCleanupAt = 0;

  return (req, res, next) => {
    const currentTime = now();

    if (currentTime >= nextCleanupAt) {
      for (const [ip, entry] of attemptsByIp) {
        if (entry.resetAt <= currentTime) attemptsByIp.delete(ip);
      }
      nextCleanupAt = currentTime + windowMs;
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    let entry = attemptsByIp.get(ip);

    if (!entry || entry.resetAt <= currentTime) {
      entry = { count: 0, resetAt: currentTime + windowMs };
      attemptsByIp.set(ip, entry);
    }

    if (entry.count >= maxAttempts) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - currentTime) / 1000)));
      return res.status(429).json({
        success: false,
        message: "Too many login attempts. Please try again later.",
      });
    }

    entry.count += 1;
    return next();
  };
}

module.exports = createLoginRateLimit;
