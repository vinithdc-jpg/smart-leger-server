const assert = require("node:assert/strict");
const { test } = require("node:test");

const pool = {
  connect: async () => {
    throw new Error("Unexpected database connection");
  },
  query: async () => {
    throw new Error("Unexpected pool query");
  },
};

function mockModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
}

mockModule("../src/config/db", pool);
mockModule("../src/controllers/settingsController", {
  getCurrentGstRate: async () => 0,
});
mockModule("../src/services/vectorService", {
  indexTransaction: async () => {},
});

const {
  createTransaction,
  getTransactions,
  updateTransaction,
} = require("../src/controllers/transactionController");
const { createMember } = require("../src/controllers/memberController");

function response() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function transactionRow(overrides = {}) {
  return {
    id: "txn_013",
    amount_excluding_gst: "100",
    debit_amount: "100",
    total_amount_with_gst: "100",
    received_amount: "0",
    member_id: "mem_012",
    club_id: "club-1",
    cgst_amount: "0",
    sgst_amount: "0",
    total_gst_amount: "0",
    ...overrides,
  };
}

function configureClient(handler) {
  const calls = [];
  const client = {
    async query(sql, values) {
      const normalizedSql = String(sql).trim();
      calls.push({ sql: normalizedSql, values });
      return handler(normalizedSql, values);
    },
    release() {
      calls.push({ sql: "RELEASE" });
    },
  };
  pool.connect = async () => client;
  return calls;
}

test("invalid paymentStatus filters return 400 before database access", async () => {
  let queries = 0;
  pool.query = async () => {
    queries += 1;
    throw new Error("should not query");
  };
  const res = response();

  await getTransactions(
    {
      query: { paymentStatus: "not-a-status" },
      user: { role: "staff", clubId: "club-1" },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, "Invalid paymentStatus");
  assert.equal(queries, 0);
});

test("invalid financial update amounts are rejected without a connection", async () => {
  let connections = 0;
  pool.connect = async () => {
    connections += 1;
    throw new Error("should not connect");
  };

  for (const body of [
    { amount: -1 },
    { amount: 0 },
    { amount: "not-a-number" },
    { receivedAmount: -0.01 },
    { receivedAmount: "Infinity" },
  ]) {
    const res = response();
    await updateTransaction(
      {
        body,
        params: { transactionId: "txn_001" },
        user: { role: "staff", clubId: "club-1" },
      },
      res,
    );
    assert.equal(res.statusCode, 400);
  }
  assert.equal(connections, 0);
});

test("over-total received amounts roll back before updating financial data", async () => {
  const calls = configureClient((sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
    if (sql.startsWith("SELECT id, amount_excluding_gst")) {
      return { rows: [transactionRow()] };
    }
    if (sql.includes("FROM members")) return { rows: [{ id: "mem_012" }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const res = response();

  await updateTransaction(
    {
      body: { receivedAmount: 101 },
      params: { transactionId: "txn_013" },
      user: { role: "staff", clubId: "club-1" },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(
    calls.some(({ sql }) => sql.startsWith("UPDATE transaction_history")),
    false,
  );
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("transaction update rolls back if member balance synchronization fails", async () => {
  const calls = configureClient((sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
    if (sql.startsWith("SELECT id, amount_excluding_gst")) {
      return { rows: [transactionRow()] };
    }
    if (sql.startsWith("UPDATE members")) {
      throw new Error("injected balance update failure");
    }
    if (sql.includes("FROM members")) return { rows: [{ id: "mem_012" }] };
    if (sql.startsWith("UPDATE transaction_history")) {
      return { rows: [transactionRow({ received_amount: "20" })] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const res = response();

  await updateTransaction(
    {
      body: { receivedAmount: 20 },
      params: { transactionId: "txn_013" },
      user: { role: "staff", clubId: "club-1" },
    },
    res,
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(
    calls.filter(({ sql }) => ["BEGIN", "ROLLBACK", "COMMIT", "RELEASE"].includes(sql)).map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK", "RELEASE"],
  );
  assert.equal(
    calls.some(({ sql }) => sql.startsWith("UPDATE transaction_history")),
    true,
  );
});

test("transaction update commits the existing total-minus-received balance formula", async () => {
  const calls = configureClient((sql) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
    if (sql.startsWith("SELECT id, amount_excluding_gst")) {
      return { rows: [transactionRow()] };
    }
    if (sql.startsWith("UPDATE members")) return { rows: [] };
    if (sql.includes("FROM members")) return { rows: [{ id: "mem_012" }] };
    if (sql.startsWith("UPDATE transaction_history")) {
      return {
        rows: [
          transactionRow({
            received_amount: "20",
            balance_amount: "80",
            pending_amount: "80",
          }),
        ],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const res = response();

  await updateTransaction(
    {
      body: { receivedAmount: 20 },
      params: { transactionId: "txn_013" },
      user: { role: "staff", clubId: "club-1" },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.transaction.balance_amount, "80");
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), false);
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("transaction creation allocates prefix IDs and atomically syncs the member", async () => {
  const calls = configureClient((sql, values) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id")) {
      return { rows: [{ id: "mem_012" }] };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("SELECT slip_no")) return { rows: [] };
    if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ count: "12" }] };
    if (sql.includes("MAX(SUBSTRING(id")) {
      return { rows: [{ next_number: "13" }] };
    }
    if (sql.startsWith("INSERT INTO transaction_history")) {
      assert.equal(values[0], "txn_013");
      assert.equal(values[7], 80);
      return { rows: [{ id: values[0], balance_amount: values[7] }] };
    }
    if (sql.startsWith("UPDATE members")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const res = response();

  await createTransaction(
    {
      body: {
        memberId: "Mem_1015",
        amount: 100,
        receivedAmount: 20,
      },
      user: { role: "staff", clubId: "club-1", staffId: "staff-1" },
    },
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.transaction.id, "txn_013");
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), false);
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("member creation serializes prefixed ID allocation and inserts returned row", async () => {
  const calls = configureClient((sql, values) => {
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
    if (sql.includes("LOWER(email)")) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("MAX(SUBSTRING(member_id")) {
      return { rows: [{ next_number: "1015" }] };
    }
    if (sql.includes("MAX(SUBSTRING(id")) {
      return { rows: [{ next_number: "13" }] };
    }
    if (sql.startsWith("INSERT INTO members")) {
      assert.equal(values[0], "mem_013");
      assert.equal(values[5], "Mem_1015");
      return { rows: [{ id: values[0], member_id: values[5] }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const res = response();

  await createMember(
    {
      body: {
        firstName: "Test",
        lastName: "Member",
        email: "test@example.com",
        clubId: "club-1",
      },
      user: { role: "super_admin", staffId: null },
    },
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.payload.member, { id: "mem_013", member_id: "Mem_1015" });
  assert.equal(calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  assert.equal(calls.at(-1).sql, "RELEASE");
});
