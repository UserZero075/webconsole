import {mkdir, readdir, unlink, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const WebConsolePlugin = async () => {
    const directory = process.env.WEBCONSOLE_EVENT_DIR;
    if (!directory) return {};
    let queue = Promise.resolve();
    let sequence = 0;
    const streamed = new Map();
    let flushTimer = null;
    const publish = event => {
        queue = queue.then(async () => {
            await mkdir(directory, {recursive: true, mode: 0o700});
            const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
            await Promise.all(files.slice(0, Math.max(0, files.length - 127)).map(name => unlink(join(directory, name)).catch(() => {})));
            const destination = join(directory, `${BigInt(Date.now()) * 1000000n + BigInt(sequence++ % 1000000)}-${randomUUID()}.json`);
            const temporary = destination + '.tmp';
            await writeFile(temporary, JSON.stringify({...event, agent: 'opencode', message: String(event.message || '').slice(0, 1200), at: Date.now() / 1000}), {mode: 0o600});
            await rename(temporary, destination);
        }).catch(() => {});
        return queue;
    };
    const flushMessages = async () => {
        clearTimeout(flushTimer);
        flushTimer = null;
        const messages = [...streamed.values()];
        streamed.clear();
        for (const message of messages) await publish(message);
    };
    const activeTurns = new Set();
    const childSessions = new Set();
    return {
        event: async ({event}) => {
            const p = event.properties || {};
            if (['session.created', 'session.updated'].includes(event.type) && p.info?.parentID) {
                childSessions.add(p.info.id);
            } else if (event.type === 'permission.asked') {
                await publish({type: 'permission', message: `OpenCode solicita permiso: ${p.permission || 'revisar en la consola'}`});
            } else if (event.type === 'permission.replied') {
                await publish({type: 'working', message: 'Solicitud de permiso respondida'});
            } else if (event.type === 'session.status' && ['busy', 'retry'].includes(p.status?.type)) {
                if (!activeTurns.has(p.sessionID)) await publish({type: 'working', message: 'OpenCode está trabajando'});
                activeTurns.add(p.sessionID);
            } else if (event.type === 'session.idle' && activeTurns.has(p.sessionID)) {
                activeTurns.delete(p.sessionID);
                await flushMessages();
                if (!childSessions.has(p.sessionID)) await publish({type: 'completed', message: 'OpenCode terminó su turno'});
            } else if (event.type === 'session.error') {
                await publish({type: 'error', message: p.error?.message || 'OpenCode notificó un error'});
            } else if (event.type === 'message.part.updated' && p.part?.type === 'text' && p.part.text) {
                // Upsert streamed messages rather than appending a row for every token.
                if (streamed.size >= 16 && !streamed.has(p.part.id)) streamed.delete(streamed.keys().next().value);
                streamed.set(p.part.id, {type: 'message', message: p.part.text.slice(-1200), key: p.part.id});
                if (!flushTimer) flushTimer = setTimeout(flushMessages, 300);
            }
        },
        'tool.execute.before': async input => {
            await publish({type: 'tool', message: `Ejecutando ${input.tool}`});
        },
        'tool.execute.after': async input => {
            await publish({type: 'tool', message: `Terminó ${input.tool}`});
        },
    };
};
