// routes/quiz.js
const express = require("express");
const router = express.Router();
const QuizSession = require("../models/QuizSession");
const adminAuth = require("../middleware/adminAuth");
const { trackEvent } = require("../services/klaviyoService");
const { createOrUpdateCustomer } = require("../services/shopifyService");

// Helper function to validate email
const isValidEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
};

// Route 1: POST /api/quiz/session - Initialize a session (public)
router.post("/session", async (req, res) => {
  try {
    const { name, email, referredByResult } = req.body;

    // Validation
    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email is required." });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format." });
    }

    let sessionName = name && name.trim() ? name.trim() : "";
    if (!sessionName) {
      sessionName = email.split("@")[0];
    }

    const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    const userAgent = req.headers["user-agent"] || "";

    const session = new QuizSession({
      name: sessionName,
      email: email.trim().toLowerCase(),
      referredByResult: referredByResult || null,
      ipAddress,
      userAgent,
      furthestStep: 0,
      answers: {},
      scores: {
        coffee: 0,
        chilli: 0,
        vanilla: 0,
        jelly: 0,
        green: 0,
      },
    });

    await session.save();

    // Track "Started Quiz" in Klaviyo in background
    trackEvent(session.email, session.name, "Started Quiz", {
      furthestStep: 0,
      referredByResult: session.referredByResult || null
    }).catch((err) => {
      console.error("[Quiz Route] Klaviyo tracking failed for Started Quiz:", err);
    });

    // Create/update customer in Shopify in background
    createOrUpdateCustomer(session.email, session.name, ["Quiz", "Quiz-Started"]).catch((err) => {
      console.error("[Quiz Route] Shopify customer sync failed for Started Quiz:", err);
    });

    return res.status(201).json({
      success: true,
      sessionId: session._id,
    });
  } catch (error) {
    console.error("Error creating quiz session:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

// Route 2: PUT /api/quiz/session/:sessionId/progress - Log intermediate progress (public)
router.put("/session/:sessionId/progress", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { step, answers, scores } = req.body;

    if (!step || isNaN(step)) {
      return res.status(400).json({ error: "Valid step number is required." });
    }

    const session = await QuizSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Quiz session not found." });
    }

    // Update session
    session.furthestStep = Math.max(session.furthestStep, Number(step));
    if (answers) {
      // Mongoose Map support: overwrite or set keys
      for (const [key, value] of Object.entries(answers)) {
        session.answers.set(key, value);
      }
    }
    if (scores) {
      session.scores = {
        coffee: scores.coffee ?? session.scores.coffee,
        chilli: scores.chilli ?? session.scores.chilli,
        vanilla: scores.vanilla ?? session.scores.vanilla,
        jelly: scores.jelly ?? session.scores.jelly,
        green: scores.green ?? session.scores.green,
      };
    }

    await session.save();

    return res.json({ success: true });
  } catch (error) {
    console.error("Error updating quiz progress:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

// Route 3: POST /api/quiz/session/:sessionId/complete - Finalize results (public)
router.post("/session/:sessionId/complete", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { winningArchetype, answers, scores } = req.body;

    if (!winningArchetype) {
      return res.status(400).json({ error: "Winning archetype is required." });
    }

    const session = await QuizSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Quiz session not found." });
    }

    // Finalize session
    session.isCompleted = true;
    session.winningArchetype = winningArchetype;
    session.furthestStep = 9; // 9 represents completed results screen

    if (answers) {
      for (const [key, value] of Object.entries(answers)) {
        session.answers.set(key, value);
      }
    }
    if (scores) {
      session.scores = {
        coffee: scores.coffee ?? session.scores.coffee,
        chilli: scores.chilli ?? session.scores.chilli,
        vanilla: scores.vanilla ?? session.scores.vanilla,
        jelly: scores.jelly ?? session.scores.jelly,
        green: scores.green ?? session.scores.green,
      };
    }

    await session.save();

    // Track "Completed Quiz" in Klaviyo in background
    trackEvent(session.email, session.name, "Completed Quiz", {
      winningArchetype: session.winningArchetype,
      scores: session.scores,
      resultsUrl: `https://beanidentity.com/pages/quiz-results?session=${session._id}`
    }).catch((err) => {
      console.error("[Quiz Route] Klaviyo tracking failed for Completed Quiz:", err);
    });

    // Create/update customer in Shopify in background with completion details
    createOrUpdateCustomer(session.email, session.name, ["Quiz-Completed", `Quiz-Outcome-${winningArchetype}`]).catch((err) => {
      console.error("[Quiz Route] Shopify customer sync failed for Completed Quiz:", err);
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Error completing quiz session:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

// Route 4: GET /api/quiz/admin/analytics - Retrieve aggregated dashboard analytics (admin only)
router.get("/admin/analytics", adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";

    const totalTraffic = await QuizSession.countDocuments();
    const referralClicks = await QuizSession.countDocuments({
      referredByResult: { $ne: null, $exists: true },
    });
    const completedCount = await QuizSession.countDocuments({ isCompleted: true });
    const completionRate = totalTraffic > 0 ? ((completedCount / totalTraffic) * 100).toFixed(1) : "0.0";

    // 1. Completion Funnel calculation
    // Count exact frequency of furthestStep (0 to 9)
    const stepCounts = Array(10).fill(0);
    const rawSteps = await QuizSession.aggregate([
      { $group: { _id: "$furthestStep", count: { $sum: 1 } } },
    ]);
    rawSteps.forEach((group) => {
      const idx = group._id;
      if (idx >= 0 && idx <= 9) {
        stepCounts[idx] = group.count;
      }
    });

    // Funnel represents the count of users who reached AT LEAST step i.
    // E.g. funnel[i] = sum(stepCounts[i...9])
    const funnel = Array(10).fill(0);
    let cumulative = 0;
    for (let i = 9; i >= 0; i--) {
      cumulative += stepCounts[i];
      funnel[i] = cumulative;
    }

    // 2. Winning archetype distribution
    const rawArchetypes = await QuizSession.aggregate([
      { $match: { isCompleted: true } },
      { $group: { _id: "$winningArchetype", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const archetypeDistribution = {};
    rawArchetypes.forEach((item) => {
      if (item._id) {
        archetypeDistribution[item._id] = item.count;
      }
    });

    // 3. Participants list (with pagination and search)
    let participantsQuery = {};
    if (search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      participantsQuery = {
        $or: [
          { name: searchRegex },
          { email: searchRegex },
          { winningArchetype: searchRegex }
        ]
      };
    }

    const participantsTotal = await QuizSession.countDocuments(participantsQuery);
    const participants = await QuizSession.find(participantsQuery)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.json({
      totalTraffic,
      referralClicks,
      completedCount,
      completionRate,
      funnel,
      archetypeDistribution,
      participants,
      pagination: {
        total: participantsTotal,
        page,
        limit,
        pages: Math.ceil(participantsTotal / limit) || 1
      }
    });
  } catch (error) {
    console.error("Error fetching quiz analytics:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

module.exports = router;
