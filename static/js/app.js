// WebConsole Dashboard JavaScript

let startTime = Date.now();

function refreshSessions() {
    fetch('/api/sessions')
        .then(res => res.json())
        .then(data => {
            updateStats(data.sessions);
            renderSessions(data.sessions);
        })
        .catch(err => console.error('Failed to refresh sessions:', err));
}

function updateStats(sessions) {
    const total = sessions.length;
    const active = sessions.filter(s => s.is_active).length;

    document.getElementById('total-sessions').textContent = total;
    document.getElementById('active-sessions').textContent = active;

    // Update active indicator color
    const activeIcon = document.querySelector('.stat-icon.active');
    if (activeIcon) {
        activeIcon.style.color = active > 0 ? '#34A853' : '#9AA0A6';
    }
}

function renderSessions(sessions) {
    const container = document.getElementById('sessions-list');

    if (sessions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="material-symbols-outlined">terminal</span>
                <p>No sessions yet</p>
                <span class="hint">Create a new session to get started</span>
            </div>
        `;
        return;
    }

    container.innerHTML = sessions.map(session => `
        <div class="session-card" data-id="${session.id}">
            <div class="session-info">
                <div class="session-status ${session.is_active ? 'active' : ''}"></div>
                <div class="session-details">
                    <span class="session-id">${session.id}</span>
                    <div class="session-meta">
                        <span>Created: ${formatDate(session.created_at)}</span>
                        <span>Active: ${formatDate(session.last_active)}</span>
                        <span>PID: ${session.pid || 'N/A'}</span>
                    </div>
                </div>
            </div>
            <div class="session-actions">
                <a href="/c/${session.token}" class="btn btn-primary btn-small" target="_blank">
                    <span class="material-symbols-outlined">open_in_new</span>
                    Open
                </a>
                <button class="btn btn-icon" onclick="copySessionLink('${session.token}')" title="Copy Link">
                    <span class="material-symbols-outlined">link</span>
                </button>
                <button class="btn btn-icon" onclick="deleteSession('${session.id}')" title="Delete">
                    <span class="material-symbols-outlined">delete</span>
                </button>
            </div>
        </div>
    `).join('');
}

function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function createSession() {
    fetch('/api/sessions', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            window.open(`/c/${data.token}`, '_blank');
            showToast('Session created!');
            refreshSessions();
        })
        .catch(err => {
            showToast('Failed to create session');
            console.error(err);
        });
}

function deleteSession(sessionId) {
    if (!confirm('Delete this session?')) return;

    fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
        .then(() => {
            showToast('Session deleted');
            refreshSessions();
        })
        .catch(err => {
            showToast('Failed to delete session');
            console.error(err);
        });
}

function copySessionLink(token) {
    const url = `${window.location.origin}/c/${token}`;
    navigator.clipboard.writeText(url);
    showToast('Link copied!');
}

function showToast(message) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function updateUptime() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;

    document.getElementById('uptime').textContent =
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    setTimeout(updateUptime, 1000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        createSession();
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        refreshSessions();
    }
});
