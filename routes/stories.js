const express = require("express");
const router = express.Router();

// Import Model
const Story = require("../models/Story");

// Import Middlewares & Utils
const uploadMiddleware = require("../middleware/upload");
const adminAuth = require("../middleware/adminAuth");
const { uploadToCloudinary } = require("../utils/cloudinary");

// helper to calculate word count
const getWordCount = (str) => {
  if (!str || str.trim() === "") return 0;
  return str.trim().split(/\s+/).length;
};

// Route 1: POST /api/stories/submit - Submit a story with optional media (public)
router.post("/submit", uploadMiddleware, async (req, res) => {
  try {
    const { name, email, handle, beanType, story } = req.body;

    // 1. Validation
    if (!name || !email || !beanType || !story) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    if (!["coffee", "chilli", "vanilla", "jelly", "green"].includes(beanType)) {
      return res.status(400).json({ error: "Invalid bean type." });
    }

    // Word count enforcement
    if (getWordCount(story) > 150) {
      return res.status(400).json({ error: "Story exceeds the maximum limit of 150 words." });
    }

    // 2. Upload media assets to Cloudinary (if provided)
    let imageUrls = [];
    let videoUrl = "";

    try {
      if (req.files && req.files.images) {
        // Enforce max 3 images for stories
        const imagesToUpload = req.files.images.slice(0, 3);
        const imageUploadPromises = imagesToUpload.map((file) =>
          uploadToCloudinary(file.buffer, "image")
        );
        const imageResults = await Promise.all(imageUploadPromises);
        imageUrls = imageResults.map((result) => result.secure_url);
      }

      if (req.files && req.files.video && req.files.video.length > 0) {
        const videoResult = await uploadToCloudinary(req.files.video[0].buffer, "video");
        videoUrl = videoResult.secure_url;
      }
    } catch (cloudinaryError) {
      console.error("Cloudinary upload error in stories:", cloudinaryError);
      return res.status(500).json({
        error: "Failed to upload story media assets to cloud storage. Please try again.",
      });
    }

    // 3. Save pending Story to MongoDB
    const newStory = new Story({
      name,
      email,
      handle: handle || "",
      beanType,
      story,
      media: {
        images: imageUrls,
        video: videoUrl,
      },
      status: "pending",
    });

    await newStory.save();

    return res.status(201).json({
      success: true,
      message: "Thank you for sharing your bean story! It has been submitted to our moderation queue.",
      storyId: newStory._id,
    });
  } catch (error) {
    console.error("Error submitting story request:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

// Route 2: GET /api/stories/approved - Fetch top 5 approved stories (public)
router.get("/approved", async (req, res) => {
  try {
    const stories = await Story.find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(5);

    return res.json(stories);
  } catch (error) {
    console.error("Error fetching approved stories:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

// Route 3: GET /api/stories/admin/all - Get all stories in moderation queue (admin only)
router.get("/admin/all", adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const skip = (pageNum - 1) * limitNum;

    const total = await Story.countDocuments(filter);
    const stories = await Story.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    return res.json({
      total,
      page: pageNum,
      limit: limitNum,
      stories,
    });
  } catch (error) {
    console.error("Error fetching admin stories:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

// Route 4: PATCH /api/stories/admin/:storyId/review - Approve/reject a story (admin only)
router.patch("/admin/:storyId/review", adminAuth, async (req, res) => {
  try {
    const { action } = req.body;

    if (!action || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "Invalid action. Must be 'approve' or 'reject'." });
    }

    const story = await Story.findById(req.params.storyId);
    if (!story) {
      return res.status(404).json({ error: "Story not found." });
    }

    story.status = action === "approve" ? "approved" : "rejected";
    story.reviewedAt = new Date();
    story.reviewedBy = "admin";

    await story.save();

    return res.json({
      success: true,
      message: `Story has been successfully ${story.status}.`,
      story,
    });
  } catch (error) {
    console.error("Error reviewing story request:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

module.exports = router;
