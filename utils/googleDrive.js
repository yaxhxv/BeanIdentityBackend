const { google } = require("googleapis");
const { Readable } = require("stream");
const GoogleDriveAuth = require("../models/GoogleDriveAuth");

/**
 * Load Google OAuth2 credentials from Environment Variables
 */
function loadOAuthCredentials() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  };
}

/**
 * Build an authenticated OAuth2 client for the admin.
 * Automatically refreshes access token if expired and updates MongoDB.
 */
async function getAuthClient() {
  const creds = loadOAuthCredentials();
  if (!creds.clientId || !creds.clientSecret || !creds.redirectUri) {
    throw new Error("Google OAuth credentials not configured in environment variables.");
  }

  const authDoc = await GoogleDriveAuth.findOne();
  if (!authDoc || !authDoc.refreshToken) {
    throw new Error("Google Drive is not linked. Please connect your Google account in the Admin Portal.");
  }

  const oauth2Client = new google.auth.OAuth2(
    creds.clientId,
    creds.clientSecret,
    creds.redirectUri
  );

  oauth2Client.setCredentials({
    access_token: authDoc.accessToken,
    refresh_token: authDoc.refreshToken,
    expiry_date: authDoc.expiryDate ? new Date(authDoc.expiryDate).getTime() : null,
  });

  // Auto-refresh listener: update DB when token is refreshed
  oauth2Client.on("tokens", async (tokens) => {
    try {
      const updateData = {};
      if (tokens.access_token) {
        updateData.accessToken = tokens.access_token;
      }
      if (tokens.expiry_date) {
        updateData.expiryDate = new Date(tokens.expiry_date);
      }
      if (tokens.refresh_token) {
        updateData.refreshToken = tokens.refresh_token;
      }

      if (Object.keys(updateData).length > 0) {
        await GoogleDriveAuth.updateOne({}, { $set: updateData });
        console.log("Google Drive access token refreshed and saved to MongoDB.");
      }
    } catch (err) {
      console.error("Failed to update refreshed token in MongoDB:", err.message);
    }
  });

  return oauth2Client;
}

/**
 * Helper: Get or create the "Beanagram Stories" folder in admin's Drive.
 */
async function getOrCreateFolder(drive, folderName = "Beanagram Stories") {
  const authDoc = await GoogleDriveAuth.findOne();
  if (authDoc && authDoc.folderId) {
    try {
      // Fast check if folder still exists
      const folderMeta = await drive.files.get({
        fileId: authDoc.folderId,
        fields: "id, trashed",
      });
      if (folderMeta.data && !folderMeta.data.trashed) {
        return authDoc.folderId;
      }
    } catch (e) {
      console.log("Stored folder ID not found or inaccessible, searching/recreating...");
    }
  }

  // Search for existing root folder
  let folderId;
  const searchResult = await drive.files.list({
    q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (searchResult.data.files && searchResult.data.files.length > 0) {
    folderId = searchResult.data.files[0].id;
  } else {
    // Create new folder
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });
    folderId = folder.data.id;
  }

  // Save folderId to DB
  await GoogleDriveAuth.updateOne({}, { $set: { folderId } });
  return folderId;
}

/**
 * Helper: Find or create a subfolder inside a parent folder on Google Drive.
 */
async function getOrCreateSubfolder(drive, parentId, folderName) {
  const searchResult = await drive.files.list({
    q: `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (searchResult.data.files && searchResult.data.files.length > 0) {
    return searchResult.data.files[0].id;
  } else {
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
    });
    return folder.data.id;
  }
}

/**
 * Upload a file buffer to Google Drive
 */
async function uploadToGoogleDrive(fileBuffer, originalName, mimeType, options = {}) {
  const { beanType, userName, userEmail } = options;
  const auth = await getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  let folderId = await getOrCreateFolder(drive);

  // If options are provided, create nested folder structure
  if (beanType) {
    const formattedBeanName = beanType.charAt(0).toUpperCase() + beanType.slice(1) + " Bean";
    folderId = await getOrCreateSubfolder(drive, folderId, formattedBeanName);

    if (userName && userEmail) {
      const userFolderName = `${userName} - ${userEmail}`;
      folderId = await getOrCreateSubfolder(drive, folderId, userFolderName);
    }
  }

  // Convert buffer to readable stream
  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  // Upload to Drive
  const response = await drive.files.create({
    requestBody: {
      name: `${Date.now()}-${originalName}`,
      parents: [folderId],
    },
    media: {
      mimeType: mimeType,
      body: stream,
    },
    fields: "id, name, webViewLink, webContentLink",
  });

  const file = response.data;

  // Make the file publicly readable so it can be streamed or accessed via public links
  try {
    await drive.permissions.create({
      fileId: file.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });
  } catch (err) {
    console.warn("Failed to set public read permissions on Google Drive file:", err.message);
  }

  // Use a relative backend proxy URL to ensure portability between local/prod environments
  const proxyUrl = `/api/stories/media/${file.id}`;

  return {
    fileId: file.id,
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink,
    proxyUrl: proxyUrl,
  };
}

/**
 * Delete a file from Google Drive
 */
async function deleteFromGoogleDrive(fileId) {
  if (!fileId) return;
  const auth = await getAuthClient();
  const drive = google.drive({ version: "v3", auth });
  try {
    await drive.files.delete({ fileId });
    console.log(`Successfully deleted file ${fileId} from Google Drive.`);
  } catch (error) {
    console.error(`Failed to delete file ${fileId} from Google Drive:`, error.message);
    if (error.code !== 404) {
      throw error;
    }
  }
}

module.exports = {
  loadOAuthCredentials,
  getAuthClient,
  uploadToGoogleDrive,
  deleteFromGoogleDrive,
};
