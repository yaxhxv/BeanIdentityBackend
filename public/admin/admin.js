document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = window.location.origin; // Dynamically resolve backend host

  // Authentication Key State
  let adminSecretKey = localStorage.getItem("bean_admin_secret") || "";

  // Core DOM Elements
  const authGate = document.getElementById("auth-gate");
  const authForm = document.getElementById("auth-form");
  const secretInput = document.getElementById("admin-secret-input");
  const authError = document.getElementById("auth-error");
  
  const adminPanel = document.getElementById("admin-panel");
  const logoutButton = document.getElementById("logout-button");
  const menuItems = document.querySelectorAll(".menu-item");
  const tabViews = document.querySelectorAll(".tab-view");

  // Stories Module DOM Elements
  const storiesPendingBadge = document.getElementById("stories-pending-badge");
  const storiesApprovedBadge = document.getElementById("stories-approved-badge");
  const storiesSubTabs = document.querySelectorAll(".sub-tab");
  const storiesGrid = document.getElementById("stories-grid");

  // State Management
  let activeTab = "stories";
  let activeStoriesSubTab = "pending";

  // ==========================================================================
  // AUTHENTICATION CONTROLLER (GATEKEEPER)
  // ==========================================================================
  const checkStoredAuth = async () => {
    if (adminSecretKey) {
      const isValid = await validateSecretKey(adminSecretKey);
      if (isValid) {
        openDashboard();
      } else {
        localStorage.removeItem("bean_admin_secret");
        adminSecretKey = "";
        showAuthGate();
      }
    } else {
      showAuthGate();
    }
  };

  const validateSecretKey = async (key) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/stories/admin/all?limit=1`, {
        headers: {
          "x-admin-key": key
        }
      });
      return response.ok;
    } catch (err) {
      console.error("Auth validation failed due to network error:", err);
      return false;
    }
  };

  const showAuthGate = () => {
    authGate.style.display = "flex";
    adminPanel.style.display = "none";
    secretInput.value = "";
    secretInput.focus();
  };

  const openDashboard = () => {
    authGate.style.display = "none";
    adminPanel.style.display = "flex";
    
    // Initialize Dashboard data
    loadModuleData(activeTab);
    updateStatsBadges();
  };

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const enteredKey = secretInput.value.trim();
    authError.style.display = "none";

    const isValid = await validateSecretKey(enteredKey);
    if (isValid) {
      adminSecretKey = enteredKey;
      localStorage.setItem("bean_admin_secret", enteredKey);
      openDashboard();
    } else {
      authError.style.display = "block";
      authError.textContent = "Invalid Access Key. Authorization Denied.";
      secretInput.focus();
    }
  });

  logoutButton.addEventListener("click", () => {
    localStorage.removeItem("bean_admin_secret");
    adminSecretKey = "";
    showAuthGate();
  });

  // ==========================================================================
  // SINGLE PAGE APPLICATION (SPA) TAB ROUTER
  // ==========================================================================
  menuItems.forEach(item => {
    item.addEventListener("click", () => {
      const targetTab = item.getAttribute("data-tab");
      
      // Update sidebar active menu style
      menuItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      
      // Update viewport visibility
      tabViews.forEach(view => view.classList.remove("active"));
      document.getElementById(`tab-${targetTab}`).classList.add("active");
      
      activeTab = targetTab;
      loadModuleData(targetTab);
    });
  });

  const loadModuleData = (tabName) => {
    if (tabName === "stories") {
      loadStories();
    }
  };

  // ==========================================================================
  // STORIES MODULE CONTROLLER (MODERATION BOARD)
  // ==========================================================================
  
  // Stories subtabs listener
  storiesSubTabs.forEach(subtab => {
    subtab.addEventListener("click", () => {
      storiesSubTabs.forEach(s => s.classList.remove("active"));
      subtab.classList.add("active");
      
      activeStoriesSubTab = subtab.getAttribute("data-subtab");
      loadStories();
    });
  });

  // Helper colors mapping
  const getBeanBadgeColor = (type) => {
    const colors = {
      coffee: '#A67C52',
      chilli: '#D32F2F',
      vanilla: '#FFF9C4',
      jelly: '#F06292',
      green: '#388E3C'
    };
    return colors[type] || '#A67C52';
  };

  // Update pending & approved count stats badges
  const updateStatsBadges = async () => {
    if (!adminSecretKey) return;
    try {
      // Pending count
      const resPending = await fetch(`${BACKEND_URL}/api/stories/admin/all?status=pending&limit=1`, {
        headers: { "x-admin-key": adminSecretKey }
      });
      if (resPending.ok) {
        const data = await resPending.json();
        storiesPendingBadge.textContent = data.total;
      }
      
      // Approved count
      const resApproved = await fetch(`${BACKEND_URL}/api/stories/admin/all?status=approved&limit=1`, {
        headers: { "x-admin-key": adminSecretKey }
      });
      if (resApproved.ok) {
        const data = await resApproved.json();
        storiesApprovedBadge.textContent = data.total;
      }
    } catch (err) {
      console.warn("Could not retrieve statistics counts", err);
    }
  };

  const loadStories = async () => {
    storiesGrid.innerHTML = '<div class="loading-state">Fetching stories from queue...</div>';
    
    try {
      const response = await fetch(`${BACKEND_URL}/api/stories/admin/all?status=${activeStoriesSubTab}&limit=50`, {
        headers: {
          "x-admin-key": adminSecretKey
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          logoutButton.click();
          return;
        }
        storiesGrid.innerHTML = `<div class="error-state">Failed to fetch stories (HTTP ${response.status})</div>`;
        return;
      }

      const data = await response.json();
      const stories = data.stories;
      
      if (!stories || stories.length === 0) {
        storiesGrid.innerHTML = `
          <div class="empty-state">
            <svg class="empty-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            <h3>No Stories Found</h3>
            <p>There are currently no stories in the "${activeStoriesSubTab}" review status.</p>
          </div>
        `;
        return;
      }

      storiesGrid.innerHTML = ""; // Clear loader

      stories.forEach(story => {
        const beanColor = getBeanBadgeColor(story.beanType);
        const card = document.createElement("div");
        card.className = "admin-story-card";
        card.setAttribute("style", `--bean-accent: ${beanColor};`);
        card.setAttribute("data-id", story._id);

        // Date layout
        const dateStr = new Date(story.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        });

        // Media Slider Markup
        let mediaMarkup = "";
        if ((story.media.images && story.media.images.length > 0) || story.media.video) {
          mediaMarkup += `<div class="card-media-gallery">`;
          
          // Image thumbnails
          if (story.media.images && story.media.images.length > 0) {
            mediaMarkup += `
              <div class="card-image-slider">
                ${story.media.images.map(img => `<img src="${img}" alt="Wearer style" onclick="window.open('${img}', '_blank')">`).join("")}
              </div>
            `;
          }
          
          // Video player
          if (story.media.video) {
            mediaMarkup += `
              <div class="card-video-player">
                <video src="${story.media.video}" controls muted playsinline></video>
              </div>
            `;
          }
          
          mediaMarkup += `</div>`;
        }

        // Action Buttons Markup (Only show review options in pending review)
        let actionsMarkup = "";
        if (story.status === "pending") {
          actionsMarkup = `
            <div class="card-action-bar">
              <button type="button" class="card-btn approve" data-action="approve">APPROVE</button>
              <button type="button" class="card-btn reject" data-action="reject">REJECT</button>
            </div>
          `;
        } else if (story.status === "approved") {
          actionsMarkup = `
            <div class="card-action-bar">
              <button type="button" class="card-btn reject" data-action="reject">MOVE TO REJECTED</button>
            </div>
          `;
        } else if (story.status === "rejected") {
          actionsMarkup = `
            <div class="card-action-bar">
              <button type="button" class="card-btn approve" data-action="approve">RESTORE & APPROVE</button>
            </div>
          `;
        }

        // Instagram handle fallback
        const handleLabel = story.handle ? `<span class="card-handle-badge">@${story.handle}</span>` : `<span class="card-handle-badge text-muted">No Handle</span>`;

        card.innerHTML = `
          <div class="card-header-wrapper">
            <div class="card-avatar">
              ${story.media.images && story.media.images.length > 0 ? `
                <img src="${story.media.images[0]}" alt="${story.name}">
              ` : `
                <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
              `}
            </div>
            <div class="card-title-meta">
              <span class="card-user-name" title="${story.name}">${story.name}</span>
              <div class="card-user-meta">
                ${handleLabel}
                <span>•</span>
                <span class="card-bean-badge">${story.beanType} Bean</span>
              </div>
            </div>
            <div class="card-timestamp">${dateStr}</div>
          </div>
          
          <div class="card-story-body">"${story.story}"</div>
          
          ${mediaMarkup}
          ${actionsMarkup}
        `;

        storiesGrid.appendChild(card);

        // Bind Button Click Events
        card.querySelectorAll(".card-btn").forEach(btn => {
          btn.addEventListener("click", async (e) => {
            const action = btn.getAttribute("data-action");
            const storyId = story._id;
            await moderateStory(storyId, action, card);
          });
        });
      });

    } catch (err) {
      console.error(err);
      storiesGrid.innerHTML = '<div class="error-state">Error connecting to server. Please try again.</div>';
    }
  };

  const moderateStory = async (storyId, action, cardElement) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/stories/admin/${storyId}/review`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminSecretKey
        },
        body: JSON.stringify({ action })
      });

      if (response.ok) {
        // Play smooth fade out transition
        cardElement.classList.add("fading-out");
        setTimeout(() => {
          cardElement.remove();
          updateStatsBadges();
          
          // If no cards left in list, trigger reload to show empty state
          if (storiesGrid.children.length === 0) {
            loadStories();
          }
        }, 300);
      } else {
        const result = await response.json();
        alert(result.error || "Failed to moderate story.");
      }
    } catch (err) {
      console.error(err);
      alert("Error connecting to server to save moderation review.");
    }
  };

  // Run Check Auth on Load
  checkStoredAuth();
});
