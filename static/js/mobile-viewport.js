/* Stable visible-viewport measurements shared by the workspace and iframes. */
(function (global) {
    'use strict';

    function install(target = global) {
        const root = target.document?.documentElement;
        if (!root) return {height: () => target.innerHeight || 0, dispose() {}};

        const viewport = target.visualViewport;
        let frame = 0;
        let disposed = false;
        let lastHeight = -1;
        let lastTop = -1;

        function measure() {
            const scale = Number(viewport?.scale || 1);
            // VisualViewport also resizes during pinch zoom. Leave layout and
            // terminal dimensions alone until zoom returns to its normal scale.
            if (Math.abs(scale - 1) > 0.02) return null;
            const height = Number(viewport?.height || target.innerHeight || 0);
            const top = Number(viewport?.offsetTop || 0);
            if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(top)) return null;
            return {height: Math.round(height), top: Math.round(top)};
        }

        function flush() {
            frame = 0;
            if (disposed || target.document.hidden) return;
            const current = measure();
            if (!current) return;

            let changed = false;
            if (Math.abs(current.height - lastHeight) >= 1) {
                root.style.setProperty('--webconsole-visible-height', `${current.height}px`);
                lastHeight = current.height;
                changed = true;
            }
            if (Math.abs(current.top - lastTop) >= 1) {
                root.style.setProperty('--webconsole-visible-top', `${current.top}px`);
                lastTop = current.top;
                changed = true;
            }
            if (changed) target.dispatchEvent(new target.CustomEvent('webconsole:viewportchange', {
                detail: {...current},
            }));
        }

        function schedule() {
            if (disposed || frame) return;
            frame = target.requestAnimationFrame(flush);
        }

        function onVisibilityChange() {
            if (!target.document.hidden) schedule();
        }

        target.addEventListener('resize', schedule, {passive: true});
        target.addEventListener('orientationchange', schedule, {passive: true});
        target.document.addEventListener('visibilitychange', onVisibilityChange);
        viewport?.addEventListener('resize', schedule, {passive: true});
        viewport?.addEventListener('scroll', schedule, {passive: true});
        schedule();

        return {
            height() {
                return measure()?.height || lastHeight || target.innerHeight || 0;
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                if (frame) target.cancelAnimationFrame(frame);
                target.removeEventListener('resize', schedule);
                target.removeEventListener('orientationchange', schedule);
                target.document.removeEventListener('visibilitychange', onVisibilityChange);
                viewport?.removeEventListener('resize', schedule);
                viewport?.removeEventListener('scroll', schedule);
            },
        };
    }

    const controller = install(global);
    global.WebConsoleMobileViewport = Object.freeze({
        height: controller.height,
        install,
        dispose: controller.dispose,
    });
    global.addEventListener('pagehide', controller.dispose, {once: true});
})(window);
