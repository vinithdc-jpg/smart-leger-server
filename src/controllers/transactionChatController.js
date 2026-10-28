const pool = require("../config/db");
const mistral = require("../config/mistral");
const vectorService = require("../services/vectorService");

const KNOWLEDGE_RELEVANCE_THRESHOLD = 0.65;

function indiaDateValue(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function utcCalendarDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

// ─── Club isolation guard ─────────────────────────────────────────────────────
function includesAnotherClub(message, clubIds, currentClubId) {
  const normalizedMessage = message.toLowerCase();
  const mentionedClubIds =
    normalizedMessage.match(/\bclub_[a-z0-9-]+\b/g) || [];
  return (
    mentionedClubIds.some((id) => id !== currentClubId.toLowerCase()) ||
    clubIds.some(
      (id) =>
        id !== currentClubId &&
        normalizedMessage.includes(String(id).toLowerCase()),
    )
  );
}

// ─── Light entity extraction (no LLM call needed) ────────────────────────────
function extractEntities(message) {
  const text = message.toLowerCase();
  const entities = {
    memberNames: [], // e.g. ["john kumar"]
    memberIds: [], // e.g. ["M-1001"]
    dateFrom: null,
    dateTo: null,
    amountHint: null,
    paymentStatus: null,
    transactionType: null,
  };

  // Member IDs like M-1001, mem_001
  const memberIdMatches = message.match(/\b(M-\d+|mem_\d+)\b/gi);
  if (memberIdMatches)
    entities.memberIds = memberIdMatches.map((m) => m.trim());

  // Payment statuses
  if (/\bpending\b/.test(text)) entities.paymentStatus = "pending";
  else if (/\bpartial\b/.test(text)) entities.paymentStatus = "partial";
  else if (/\bcompleted?\b/.test(text)) entities.paymentStatus = "completed";

  // Transaction types
  if (/\bamc\b/.test(text)) entities.transactionType = "amc";
  else if (/\bmembership\b/.test(text)) entities.transactionType = "membership";

  // Amounts
  const amtMatch = message.match(/₹?\s*(\d[\d,]*(?:\.\d+)?)/);
  if (amtMatch) entities.amountHint = parseFloat(amtMatch[1].replace(/,/g, ""));

  // Date ranges — "last month", "this month", "last 3 months", "2024", specific dates
  const now = new Date();
  const [year, month, day] = indiaDateValue(now).split("-").map(Number);
  const today = utcCalendarDate(year, month - 1, day);
  if (/last\s+month/.test(text)) {
    entities.dateFrom = utcCalendarDate(year, month - 2, 1);
    entities.dateTo = utcCalendarDate(year, month - 1, 0);
  } else if (/this\s+month/.test(text)) {
    entities.dateFrom = utcCalendarDate(year, month - 1, 1);
    entities.dateTo = today;
  } else if (/last\s+(\d+)\s+months?/.test(text)) {
    const monthsMatch = text.match(/last\s+(\d+)\s+months?/);
    const n = parseInt(monthsMatch[1], 10);
    entities.dateFrom = utcCalendarDate(year, month - 1 - n, 1);
    entities.dateTo = today;
  } else if (/this\s+year/.test(text)) {
    entities.dateFrom = `${year}-01-01`;
    entities.dateTo = today;
  } else if (/last\s+year/.test(text)) {
    entities.dateFrom = `${year - 1}-01-01`;
    entities.dateTo = `${year - 1}-12-31`;
  }
  // 4-digit year mention
  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (yearMatch && !entities.dateFrom) {
    entities.dateFrom = `${yearMatch[1]}-01-01`;
    entities.dateTo = `${yearMatch[1]}-12-31`;
  }
  // Specific date like "2024-09-15" or "15/09/2024"
  const isoDateMatch = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDateMatch && !entities.dateFrom) {
    entities.dateFrom = isoDateMatch[1];
    entities.dateTo = isoDateMatch[1];
  }

  return entities;
}

// ─── Extract member name hints from message ───────────────────────────────────
function extractNameHints(message) {
  // Remove common question words to isolate possible names
  const cleaned = message
    .replace(
      /\b(what|about|show|me|his|her|their|the|a|an|tell|find|get|for|of|and|is|are|was|has|have|did|does|do|payment|transaction|pending|balance|history|summary|member|status|how|much|how much|when|where|who)\b/gi,
      " ",
    )
    .replace(/[^a-zA-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter((w) => w.length > 2);
  return words; // Used for ILIKE matching against first/last name
}

//mark them, Then ask stackoverflow

function isSafeKnowledgeCandidate(candidate) {
  const isReusable =
    candidate?.reusable === true ||
    (typeof candidate?.reusable === "string" &&
      candidate.reusable.trim().toLowerCase() === "true");

  if (!isReusable) {
    return { safe: false, reason: "not_reusable" };
  }
  if (!candidate.title?.trim() || !candidate.content?.trim()) {
    return { safe: false, reason: "missing_candidate_fields" };
  }

  const text = `${candidate.title} ${candidate.content}`;
  if (
    /₹|\b(?:rs\.?|inr)\s*[\d,]+|\b(?:member\s*id|mem_|M-\d+|txn_|slip|invoice|phone|email)\b|\b20\d{2}-\d{2}-\d{2}\b|@[\w.-]+/i.test(
      text,
    )
  ) {
    return { safe: false, reason: "private_or_transaction_data" };
  }

  return { safe: true };
}

async function createKnowledgeCandidate({
  question,
  answer,
  clubId,
  sourceId,
}) {
  try {
    const response = await mistral.chat.completions.create({
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Decide whether this club-assistant exchange contains reusable knowledge.
Only mark reusable=true for a general policy, rule, FAQ, or procedure that could help answer future questions.
Never create knowledge from member balances, transaction values, names, IDs, dates tied to one transaction, contact details, or temporary/private facts.
When the answer contains private data but also explains a general rule, extract only the general rule and remove all private values.
Return only valid JSON. reusable must be a boolean, never a string:
{
  "reusable": true or false,
  "title": "short title or empty string",
  "category": "policy, rule, faq, or procedure",
  "content": "general reusable knowledge or empty string"
}
          `.trim(),
        },
        {
          role: "user",
          content: `Question:\n${question}\n\nAnswer:\n${answer}`,
        },
      ],
    });

    const candidate = JSON.parse(
      response.choices?.[0]?.message?.content || "{}",
    );

    const safety = isSafeKnowledgeCandidate(candidate);
    if (!safety.safe) {
      console.log(`Knowledge candidate skipped: ${safety.reason}`);
      return null;
    }

    const result = await vectorService.saveKnowledgeCandidate({
      clubId,
      title: candidate.title,
      category: candidate.category,
      content: candidate.content,
      sourceId,
    });
    console.log(
      result.created
        ? `Knowledge candidate saved: ${result.documentId}`
        : `Knowledge candidate skipped: ${result.reason}`,
    );
    return result;
  } catch (error) {
    console.error("Knowledge candidate creation skipped:", error.message);
    return null;
  }
}

// ─── Main chat handler ─────────────────────────────────────────────────────────
const transactionChat = async (req, res) => {
  try {
    const { message, memberId, history = [] } = req.body;

    // 1. Validate request
    if (!message || !message.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "message is required" });
    }

    const clubId = req.user?.clubId;
    const staffId = req.user?.staffId;

    if (!clubId || !staffId) {
      return res
        .status(401)
        .json({ success: false, message: "A valid staff session is required" });
    }

    // 2. Verify staff + club
    const staffResult = await pool.query(
      `SELECT s.id, s.club_id FROM staff s
       INNER JOIN clubs c ON c.club_id = s.club_id
       WHERE s.id = $1 AND s.club_id = $2 AND s.status = 'active' AND c.status = 'active'`,
      [staffId, clubId],
    );

    if (staffResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Your staff account cannot access this club",
      });
    }

    // 3. Club isolation check
    const clubResult = await pool.query("SELECT club_id FROM clubs");
    const clubIds = clubResult.rows.map((r) => r.club_id);
    if (includesAnotherClub(message, clubIds, clubId)) {
      const answer =
        "You can only search members and transactions that belong to your club.";
      await pool.query(
        `INSERT INTO ai_chat_logs (club_id, staff_id, member_id, question, answer)
         VALUES ($1, $2, NULL, $3, $4)`,
        [clubId, staffId, message.trim(), answer],
      );
      return res.status(200).json({
        success: true,
        answer,
        contextMemberId: null,
      });
    }

    // 4. Entity extraction from message
    const entities = extractEntities(message);
    const nameHints = extractNameHints(message);

    // 5. Derive conversation context from history (carry forward last mentioned member)
    let contextMemberId = memberId || null;
    let contextMemberName = null;
    if (!contextMemberId && history.length > 0) {
      // Look for a previously used member context in last assistant message metadata
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.role === "assistant" && h.contextMemberId) {
          contextMemberId = h.contextMemberId;
          break;
        }
      }
    }

    // 6. Resolve member(s) from DB — try explicit ID first, then name/ID hints
    let selectedMember = null;
    let matchedMembers = [];

    if (contextMemberId) {
      const r = await pool.query(
        `SELECT id, member_id, first_name, last_name, email, phone, pending_amount, amc_status
         FROM members WHERE id = $1 AND club_id = $2`,
        [contextMemberId, clubId],
      );
      if (r.rows.length > 0) selectedMember = r.rows[0];
    }

    if (!selectedMember && entities.memberIds.length > 0) {
      const r = await pool.query(
        `SELECT id, member_id, first_name, last_name, email, phone, pending_amount, amc_status
         FROM members WHERE member_id = ANY($1::text[]) AND club_id = $2 LIMIT 3`,
        [entities.memberIds, clubId],
      );
      if (r.rows.length > 0) {
        selectedMember = r.rows[0];
        matchedMembers = r.rows;
      }
    }

    if (!selectedMember && nameHints.length > 0) {
      // Build ILIKE conditions for each hint word against first_name OR last_name
      const conditions = nameHints
        .slice(0, 6)
        .map(
          (_, i) => `(first_name ILIKE $${i + 2} OR last_name ILIKE $${i + 2})`,
        )
        .join(" OR ");
      const values = [clubId, ...nameHints.slice(0, 6).map((n) => `%${n}%`)];

      const r = await pool.query(
        `SELECT id, member_id, first_name, last_name, email, phone, pending_amount, amc_status
         FROM members WHERE club_id = $1 AND (${conditions}) LIMIT 5`,
        values,
      );
      if (r.rows.length > 0) {
        selectedMember = r.rows[0];
        matchedMembers = r.rows;
      }
    }

    if (selectedMember) contextMemberId = selectedMember.id;

    // 7. Fetch transactions with targeted filters
    const txnValues = [clubId];
    let txnWhere = "th.club_id = $1";

    if (selectedMember) {
      txnValues.push(selectedMember.id);
      txnWhere += ` AND th.member_id = $${txnValues.length}`;
    }
    if (entities.paymentStatus) {
      txnValues.push(entities.paymentStatus);
      txnWhere += ` AND LOWER(th.payment_status) = $${txnValues.length}`;
    }
    if (entities.transactionType) {
      txnValues.push(entities.transactionType);
      txnWhere += ` AND LOWER(th.types) = $${txnValues.length}`;
    }
    if (entities.dateFrom) {
      txnValues.push(entities.dateFrom);
      txnWhere += ` AND th.amount_taken_date >= ($${txnValues.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    }
    if (entities.dateTo) {
      txnValues.push(entities.dateTo);
      txnWhere += ` AND th.amount_taken_date < (($${txnValues.length}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    }

    // Limit more tightly when a specific member is selected (more context quality)
    const txnLimit = selectedMember ? 30 : 20;
    txnValues.push(txnLimit);

    const txnResult = await pool.query(
      `SELECT
        th.id, th.slip_no, (th.amount_taken_date AT TIME ZONE 'Asia/Kolkata')::date AS date,
        th.payment_status, th.payment_method, th.types,
        th.amount_excluding_gst, th.total_gst_amount, th.total_amount_with_gst,
        th.received_amount, th.balance_amount, th.pending_amount,
        th.remarks,
        m.member_id AS member_number,
        m.first_name || ' ' || m.last_name AS member_name
       FROM transaction_history th
       INNER JOIN members m ON th.member_id = m.id AND m.club_id = th.club_id
       WHERE ${txnWhere}
       ORDER BY th.amount_taken_date DESC
       LIMIT $${txnValues.length}`,
      txnValues,
    );

    const transactions = txnResult.rows;

    // 8. Aggregate member-level summary when a member is resolved
    let memberSummary = null;
    if (selectedMember) {
      //Check what happen
      const sumResult = await pool.query(
        `SELECT
          COUNT(*)::int AS total_transactions,
          COALESCE(SUM(total_amount_with_gst), 0)::numeric AS total_billed,
          COALESCE(SUM(received_amount), 0)::numeric AS total_received,
          COALESCE(SUM(balance_amount), 0)::numeric AS total_pending,
          COUNT(*) FILTER (WHERE LOWER(payment_status) = 'completed')::int AS completed_count,
          COUNT(*) FILTER (WHERE LOWER(payment_status) = 'partial')::int AS partial_count,
          COUNT(*) FILTER (WHERE LOWER(payment_status) = 'pending')::int AS pending_count
         FROM transaction_history
         WHERE member_id = $1 AND club_id = $2`,
        [selectedMember.id, clubId],
      );
      memberSummary = sumResult.rows[0];
    }

    // 9. Search club-scoped knowledge through PostgreSQL pgvector
    let knowledgeDocuments = [];
    try {
      const vectorResults = await vectorService.searchDocuments({
        query: message,
        clubId,
        limit: 20,
        threshold: KNOWLEDGE_RELEVANCE_THRESHOLD,
      });
      knowledgeDocuments = vectorResults
        .filter(
          (document) =>
            !["transaction", "payment", "member"].includes(
              document.source_type,
            ),
        )
        .slice(0, 5);
    } catch (vectorErr) {
      console.error("pgvector search error:", vectorErr.message);
    }

    // 10. Build context strings
    //Understand what happen
    const memberContext = selectedMember
      ? `Member ID: ${selectedMember.member_id}
Name: ${selectedMember.first_name} ${selectedMember.last_name}
Phone: ${selectedMember.phone || "N/A"}  |  AMC Status: ${selectedMember.amc_status}
Overall Pending Amount: ₹${Number(selectedMember.pending_amount || 0).toFixed(2)}
${
  memberSummary
    ? `Total Billed: ₹${Number(memberSummary.total_billed).toFixed(2)} | Total Received: ₹${Number(memberSummary.total_received).toFixed(2)} | Total Pending: ₹${Number(memberSummary.total_pending).toFixed(2)}
Transactions: ${memberSummary.total_transactions} (Completed: ${memberSummary.completed_count}, Partial: ${memberSummary.partial_count}, Pending: ${memberSummary.pending_count})`
    : ""
}`.trim()
      : matchedMembers.length > 1
        ? `Multiple members found: ${matchedMembers.map((m) => `${m.first_name} ${m.last_name} (${m.member_id})`).join(", ")}`
        : "No specific member identified from the question.";

    const transactionContext = transactions
      .map((t) => {
        const parts = [
          `Slip: ${t.slip_no || "N/A"}`,
          `Member: ${t.member_name} (${t.member_number})`,
          `Date: ${t.date}`,
          `Status: ${t.payment_status}`,
          `Base: ₹${Number(t.amount_excluding_gst || 0).toFixed(2)}`,
          `GST: ₹${Number(t.total_gst_amount || 0).toFixed(2)}`,
          `Total: ₹${Number(t.total_amount_with_gst || 0).toFixed(2)}`,
          `Received: ₹${Number(t.received_amount || 0).toFixed(2)}`,
          `Pending: ₹${Number(t.balance_amount || 0).toFixed(2)}`,
          `Method: ${t.payment_method || "N/A"}`,
          `Type: ${t.types || "N/A"}`,
        ];
        if (t.remarks) parts.push(`Remarks: ${t.remarks}`);
        return parts.join(" | ");
      })
      .join("\n");

    const knowledgeContext = knowledgeDocuments
      .map((d) => `[${d.category || "general"}] ${d.title}:\n${d.content}`)
      .join("\n\n");

    // 11. Build conversation messages with history
    const conversationMessages = [
      {
        role: "system",
        content: `You are Smart Ledger AI, an intelligent assistant for club financial management.
You help staff answer questions about members, transactions, payments, AMC, and club policies.

STRICT RULES:
1. Answer ONLY from the data provided below — never invent amounts, dates, names, or transactions.
2. If the data does not contain the requested information, say so clearly.
3. Never expose data belonging to another club.
4. Use clean markdown — headings, bullet lists, bold labels, and tables where appropriate.
5. Do not put tables inside code blocks. Do not use HTML.
6. Keep responses concise but complete.
7. When the user asks follow-up questions ("What about him?", "Last month?"), use the conversation context and member resolved below.
8. Currency is in INR (₹).

TODAY's DATE: ${indiaDateValue(new Date())}
CLUB ID: ${clubId}
RESOLVED MEMBER: ${contextMemberId || "None"}`,
      },
    ];

    // Include up to last 6 history turns
    const relevantHistory = (history || []).slice(-6);
    for (const turn of relevantHistory) {
      if (turn.role === "user" || turn.role === "assistant") {
        conversationMessages.push({ role: turn.role, content: turn.content });
      }
    }

    // Add the current user question with injected data
    conversationMessages.push({
      role: "user",
      content: `QUESTION: ${message}

==== MEMBER INFO ====
${memberContext}

==== TRANSACTIONS (${transactions.length} records) ====
${transactionContext || "No transactions matched the filters."}

==== KNOWLEDGE / POLICIES (VECTOR SEARCH RESULTS) ====
${knowledgeContext || "No relevant knowledge was found. Use only the member and transaction data above; do not invent policy details."}

Answer based only on the data above.`,
    });

    // 12. Call Mistral
    const mistralResponse = await mistral.chat.completions.create({
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",
      temperature: 0.1,
      max_completion_tokens: 1024,
      messages: conversationMessages,
    });

    const answer = mistralResponse.choices?.[0]?.message?.content;
    if (!answer) {
      return res
        .status(500)
        .json({ success: false, message: "Mistral did not return an answer" });
    }

    const chatLogResult = await pool.query(
      `INSERT INTO ai_chat_logs (club_id, staff_id, member_id, question, answer)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [clubId, staffId, selectedMember?.id || null, message.trim(), answer],
    );

    await createKnowledgeCandidate({
      question: message,
      answer,
      clubId,
      sourceId: chatLogResult.rows[0].id,
    });

    // 13. Return response (include contextMemberId so frontend can thread it)
    return res.status(200).json({
      success: true,
      question: message,
      answer,
      contextMemberId,
      member: selectedMember
        ? {
            id: selectedMember.id,
            memberId: selectedMember.member_id,
            name: `${selectedMember.first_name} ${selectedMember.last_name}`,
          }
        : null,
      sources: {
        transactions: transactions.length,
        knowledge: knowledgeDocuments.length,
      },
    });
  } catch (error) {
    console.error("Transaction chat error:", {
      status: error.status,
      message: error.message,
    });

    if (
      error.status === 401 ||
      error.error?.error?.code === "invalid_api_key"
    ) {
      return res.status(503).json({
        success: false,
        message: "AI service unavailable. Check Mistral_Api.",
      });
    }
    if (
      error.status === 413 ||
      error.error?.error?.code === "rate_limit_exceeded"
    ) {
      return res.status(503).json({
        success: false,
        message: "AI rate-limited. Please try again shortly.",
      });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to process transaction chat" });
  }
};

module.exports = { transactionChat, isSafeKnowledgeCandidate };
