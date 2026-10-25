const TURN_STARTED_EVENTS = new Set([
    'session.next.prompt.admitted',
    'session.next.step.started',
    'session.next.tool.called',
    'session.next.tool.progress',
    'session.next.retried',
]);

export function normalizeOpenCodeEvent(event) {
    if (!event || typeof event.type !== 'string') return null;
    const properties = {...(event.properties || event.data || {})};
    let type = event.type;

    if (['session.created', 'session.updated'].includes(type)) {
        if (properties.info && !properties.info.id && properties.sessionID) {
            properties.info = {...properties.info, id:properties.sessionID};
        } else if (!properties.info && properties.sessionID) {
            properties.info = {...properties, id:properties.sessionID};
        }
    } else if (TURN_STARTED_EVENTS.has(type) || type === 'session.execution.started') {
        type = 'session.status';
        properties.status = {type:'busy'};
    } else if (type === 'session.execution.succeeded') {
        type = 'session.status';
        properties.status = {type:'idle'};
    } else if (type === 'session.execution.failed') {
        type = 'session.error';
    } else if (type === 'session.execution.interrupted') {
        type = 'session.interrupted';
    }

    return {type, properties};
}

export function createOpenCodeStatusHandler({
    publish,
    flushMessages,
    recordMainSession,
    getMainSessionID,
    activeTurns = new Set(),
    childSessions = new Set(),
}) {
    return async input => {
        const event = normalizeOpenCodeEvent(input);
        if (!event) return false;
        const {properties} = event;
        const info = properties.info;

        if (['session.created', 'session.updated'].includes(event?.type) && info) {
            if (info.parentID) childSessions.add(info.id);
            else await recordMainSession(info);
            return true;
        }

        const sessionID = properties.sessionID;
        const mainSessionID = getMainSessionID();
        if (sessionID && mainSessionID && sessionID !== mainSessionID) return true;

        if (['permission.asked', 'permission.v2.asked'].includes(event?.type)) {
            const permission = properties.permission || properties.action || 'revisar en la consola';
            await publish({type:'permission', message:`OpenCode solicita permiso: ${permission}`});
        } else if (['permission.replied', 'permission.v2.replied'].includes(event?.type)) {
            if (sessionID) activeTurns.add(sessionID);
            await publish({type:'working', message:'OpenCode está trabajando'});
        } else if (event.type === 'session.status' && ['busy', 'retry'].includes(properties.status?.type)) {
            if (!activeTurns.has(sessionID)) await publish({type:'working', message:'OpenCode está trabajando'});
            activeTurns.add(sessionID);
        } else if ((event.type === 'session.idle'
                || (event.type === 'session.status' && properties.status?.type === 'idle'))
                && activeTurns.has(sessionID)) {
            activeTurns.delete(sessionID);
            await flushMessages();
            if (!childSessions.has(sessionID)) await publish({type:'completed', message:'OpenCode terminó su turno'});
        } else if (event.type === 'session.interrupted') {
            if (sessionID) activeTurns.delete(sessionID);
            await publish({type:'interrupted', message:'El turno de OpenCode fue interrumpido'});
        } else if (event.type === 'session.error') {
            if (sessionID) activeTurns.delete(sessionID);
            await publish({type:'error', message:properties.error?.message || 'OpenCode notificó un error'});
        } else {
            return false;
        }
        return true;
    };
}
