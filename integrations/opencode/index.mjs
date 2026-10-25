import {Plugin} from '@opencode/plugin';
import {mkdir, readdir, unlink, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOpenCodeStatusHandler, normalizeOpenCodeEvent} from './opencode_events.mjs';

export default Plugin.define({
    id:'webconsole.agent-status',
    async setup(ctx) {
        const directory = process.env.WEBCONSOLE_EVENT_DIR;
        if (!directory) return;

        let queue = Promise.resolve();
        let sequence = 0;
        let recordedSessionID = null;
        let flushTimer = null;
        let reconnectTimer = null;
        let mainSessionID = null;
        const streamed = new Map();
        const controller = new AbortController();

        const recordMainSession = info => {
            if (!info || typeof info.id !== 'string' || !/^ses[A-Za-z0-9_-]{1,128}$/.test(info.id)
                    || info.parentID || recordedSessionID === info.id) return Promise.resolve();
            const conversation = {session_id:info.id,
                cwd:info.location?.directory || info.directory || process.cwd(), recorded_at:Date.now()};
            recordedSessionID = info.id;
            mainSessionID = info.id;
            queue = queue.then(async () => {
                const parent = join(directory, '..');
                await mkdir(parent, {recursive:true, mode:0o700});
                const destination = join(parent, 'opencode-session.json');
                const temporary = `${destination}.${randomUUID()}.tmp`;
                await writeFile(temporary, JSON.stringify(conversation), {mode:0o600});
                await rename(temporary, destination);
            }).catch(() => {});
            return queue;
        };

        const publish = event => {
            queue = queue.then(async () => {
                await mkdir(directory, {recursive:true, mode:0o700});
                const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
                await Promise.all(files.slice(0, Math.max(0, files.length - 127))
                    .map(name => unlink(join(directory, name)).catch(() => {})));
                const destination = join(directory, `${BigInt(Date.now()) * 1000000n + BigInt(sequence++ % 1000000)}-${randomUUID()}.json`);
                const temporary = destination + '.tmp';
                await writeFile(temporary, JSON.stringify({...event, agent:'opencode',
                    message:String(event.message || '').slice(0, 1200), at:Date.now() / 1000}), {mode:0o600});
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

        const handleStatusEvent = createOpenCodeStatusHandler({
            publish,
            flushMessages,
            recordMainSession,
            getMainSessionID:() => mainSessionID,
        });

        await ctx.session.hook('prompt', async () => {
            await publish({type:'working', message:'OpenCode está trabajando'});
        });
        await ctx.tool.hook('execute.before', async event => {
            await publish({type:'working', message:'OpenCode está trabajando'});
            await publish({type:'tool', message:`Ejecutando ${event.tool || 'herramienta'}`});
        });
        await ctx.tool.hook('execute.after', async event => {
            await publish({type:'tool', message:`Terminó ${event.tool || 'herramienta'}`});
        });

        const listen = async () => {
            while (!controller.signal.aborted) {
                try {
                    for await (const event of ctx.event.subscribe({signal:controller.signal})) {
                        const normalized = normalizeOpenCodeEvent(event);
                        if (!normalized) continue;
                        if (await handleStatusEvent(normalized)) continue;
                        const properties = normalized.properties;
                        if (normalized.type === 'message.part.updated' && properties.part?.type === 'text'
                                && properties.part.text) {
                            const part = properties.part;
                            if (streamed.size >= 16 && !streamed.has(part.id)) {
                                streamed.delete(streamed.keys().next().value);
                            }
                            streamed.set(part.id, {type:'message', message:part.text.slice(-1200), key:part.id});
                            if (!flushTimer) flushTimer = setTimeout(flushMessages, 300);
                        }
                    }
                } catch (_) {
                    if (controller.signal.aborted) return;
                }
                if (!controller.signal.aborted) {
                    await new Promise(resolve => {
                        reconnectTimer = setTimeout(resolve, 1000);
                    });
                    reconnectTimer = null;
                }
            }
        };
        void listen();

        return async () => {
            controller.abort();
            clearTimeout(flushTimer);
            clearTimeout(reconnectTimer);
            await flushMessages();
        };
    },
});
