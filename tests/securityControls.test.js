const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const pool = require("../src/config/db");
const createLoginRateLimit = require("../src/middleware/loginRateLimit");

function makeResponse() {
  return {
    headers: {},
    statusCode: undefined,
    body: undefined,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("login limiter permits five requests then returns 429 with Retry-After", () => {
  let currentTime = 1_000;
  let nextCalls = 0;
  const limiter = createLoginRateLimit({
    windowMs: 30_000,
    maxAttempts: 5,
    now: () => currentTime,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    limiter({ ip: "192.0.2.1" }, makeResponse(), () => {
      nextCalls += 1;
    });
  }

  const response = makeResponse();
  limiter({ ip: "192.0.2.1" }, response, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 5);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["Retry-After"], "30");
  assert.equal(response.body.success, false);

  currentTime += 30_000;
  limiter({ ip: "192.0.2.1" }, makeResponse(), () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 6);
});

test("login limiter tracks clients independently", () => {
  const limiter = createLoginRateLimit({ maxAttempts: 1 });
  const firstClientResponse = makeResponse();
  let firstClientNextCalls = 0;

  limiter({ ip: "192.0.2.1" }, firstClientResponse, () => {
    firstClientNextCalls += 1;
  });
  limiter({ ip: "192.0.2.1" }, firstClientResponse, () => {
    firstClientNextCalls += 1;
  });

  let secondClientNextCalls = 0;
  limiter({ ip: "192.0.2.2" }, makeResponse(), () => {
    secondClientNextCalls += 1;
  });

  assert.equal(firstClientNextCalls, 1);
  assert.equal(firstClientResponse.statusCode, 429);
  assert.equal(secondClientNextCalls, 1);
});

function loadDatabaseSslOptions(environment) {
  const dbPath = path.join(__dirname, "..", "src", "config", "db.js");
  const output = execFileSync(
    process.execPath,
    ["-e", `console.log(JSON.stringify(require(${JSON.stringify(dbPath)}).options.ssl))`],
    {
      env: {
        ...process.env,
        DATABASE_SSL: "",
        DATABASE_SSL_CA: "",
        ...environment,
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(output.trim());
}

test("PostgreSQL TLS verifies certificates by default in production", () => {
  assert.deepEqual(loadDatabaseSslOptions({ NODE_ENV: "production" }), {
    rejectUnauthorized: true,
  });
});

test("local PostgreSQL can disable TLS without weakening production defaults", () => {
  assert.equal(
    loadDatabaseSslOptions({
      NODE_ENV: "development",
      DATABASE_SSL: "false",
    }),
    false,
  );
});

test("remote development PostgreSQL accepts a configured CA with verification enabled", () => {
  const ca = "-----BEGIN CERTIFICATE-----\\ntrusted-test-ca\\n-----END CERTIFICATE-----";
  assert.deepEqual(
    loadDatabaseSslOptions({
      NODE_ENV: "development",
      DATABASE_SSL: "true",
      DATABASE_SSL_CA: ca,
    }),
    {
      rejectUnauthorized: true,
      ca: ca.replace(/\\n/g, "\n"),
    },
  );
});

test("super-admin login keeps the JWT in its HttpOnly cookie only", async () => {
  const { superAdminLogin } = require("../src/controllers/superAdmin");
  const originalQuery = pool.query;
  const originalJwtSecret = process.env.JWT_SECRET;
  const passwordHash = await bcrypt.hash("test-only-password", 1);
  let cookie;
  let responseBody;
  let responseStatus;

  process.env.JWT_SECRET = "test-only-jwt-secret";
  pool.query = async () => ({
    rows: [
      {
        id: "test-admin",
        email: "admin@example.test",
        password: passwordHash,
        name: "Test Admin",
      },
    ],
  });

  const res = {
    cookie(name, value, options) {
      cookie = { name, value, options };
    },
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  try {
    await superAdminLogin(
      { body: { email: "admin@example.test", password: "test-only-password" } },
      res,
    );
  } finally {
    pool.query = originalQuery;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }

  assert.equal(responseStatus, 200);
  assert.equal(cookie.name, "admin_token");
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(typeof cookie.value, "string");
  assert.equal(Object.hasOwn(responseBody, "token"), false);
  assert.deepEqual(Object.keys(responseBody), ["success", "message", "admin"]);
});
