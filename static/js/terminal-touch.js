/* Touch navigation for xterm's active mouse-tracking modes. */
(function (global) {
    'use strict';

    const WHEEL_MODES = new Set(['vt200', 'drag', 'any']);
    const AXIS_THRESHOLD_PX = 8;
    const AXIS_DOMINANCE = 1.2;
    const MAX_WHEEL_EVENTS_PER_MOVE = 8;

    function bind(terminal, onStateChange = () => {}) {
        const screen = terminal?.element?.querySelector('.xterm-screen');
        if (!screen) return {dispose() {}};

        let gesture = null;
        let disposed = false;

        function isAlternateBuffer() {
            return terminal.buffer?.active?.type === 'alternate';
        }

        function clearGesture() {
            gesture = null;
        }

        function onTouchStart(event) {
            if (disposed) return;
            if (event.touches.length !== 1) {
                clearGesture();
                return;
            }

            const touch = event.changedTouches[0];
            if (!touch) return;
            const mode = terminal.modes?.mouseTrackingMode || 'none';
            const alternate = isAlternateBuffer();
            if (!alternate && mode === 'none') return;

            gesture = {
                identifier: touch.identifier,
                startX: touch.clientX,
                startY: touch.clientY,
                lastY: touch.clientY,
                mode,
                alternate,
                vertical: false,
                remainder: 0,
                supported: WHEEL_MODES.has(mode),
            };
        }

        function onTouchMove(event) {
            if (!gesture || disposed) return;
            if (event.touches.length !== 1) {
                clearGesture();
                return;
            }

            let touch = null;
            for (const candidate of event.touches) {
                if (candidate.identifier === gesture.identifier) {
                    touch = candidate;
                    break;
                }
            }
            if (!touch) {
                clearGesture();
                return;
            }

            const totalX = touch.clientX - gesture.startX;
            const totalY = touch.clientY - gesture.startY;
            if (!gesture.vertical) {
                if (Math.max(Math.abs(totalX), Math.abs(totalY)) < AXIS_THRESHOLD_PX) return;
                if (Math.abs(totalX) >= Math.abs(totalY) * AXIS_DOMINANCE) {
                    clearGesture();
                    return;
                }
                if (Math.abs(totalY) < Math.abs(totalX) * AXIS_DOMINANCE) return;
                gesture.vertical = true;
                onStateChange(gesture.supported ? 'wheel' : 'unsupported');
            }

            // A second finger, mode transition, or buffer transition cancels the
            // gesture. Nothing is converted to keys, clicks, or terminal text.
            if (event.cancelable) event.preventDefault();
            if ((terminal.modes?.mouseTrackingMode || 'none') !== gesture.mode
                || isAlternateBuffer() !== gesture.alternate) {
                clearGesture();
                return;
            }

            if (!gesture.supported) {
                gesture.lastY = touch.clientY;
                return;
            }

            const rect = screen.getBoundingClientRect();
            const rowHeight = rect.height > 0 && terminal.rows > 0
                ? Math.max(8, rect.height / terminal.rows) : 20;
            // Match xterm's native touch convention: a finger moving down
            // corresponds to a wheel-up event (toward earlier output).
            gesture.remainder += gesture.lastY - touch.clientY;
            gesture.lastY = touch.clientY;

            let sent = 0;
            while (Math.abs(gesture.remainder) >= rowHeight && sent < MAX_WHEEL_EVENTS_PER_MOVE) {
                const direction = Math.sign(gesture.remainder);
                const wheel = new global.WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaX: 0,
                    deltaY: direction,
                    deltaMode: global.WheelEvent.DOM_DELTA_LINE,
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                });
                // This goes through xterm's own wheel handler and mouse protocol
                // encoder. Only modes that advertise wheel events are allowed.
                terminal.element.dispatchEvent(wheel);
                gesture.remainder -= direction * rowHeight;
                sent++;
            }
        }

        function onTouchEnd(event) {
            if (!gesture) return;
            let active = false;
            for (let index = 0; index < event.touches.length; index++) {
                if (event.touches[index].identifier === gesture.identifier) active = true;
            }
            if (event.type === 'touchcancel' || !active) {
                clearGesture();
            }
        }

        function onPointerCancel() {
            clearGesture();
        }

        screen.addEventListener('touchstart', onTouchStart, {passive: true});
        screen.addEventListener('touchmove', onTouchMove, {passive: false});
        screen.addEventListener('touchend', onTouchEnd, {passive: true});
        screen.addEventListener('touchcancel', onTouchEnd, {passive: true});
        screen.addEventListener('pointercancel', onPointerCancel);
        global.document?.addEventListener('visibilitychange', onPointerCancel);

        return {
            dispose() {
                if (disposed) return;
                disposed = true;
                clearGesture();
                screen.removeEventListener('touchstart', onTouchStart);
                screen.removeEventListener('touchmove', onTouchMove);
                screen.removeEventListener('touchend', onTouchEnd);
                screen.removeEventListener('touchcancel', onTouchEnd);
                screen.removeEventListener('pointercancel', onPointerCancel);
                global.document?.removeEventListener('visibilitychange', onPointerCancel);
            },
        };
    }

    global.WebConsoleTerminalTouch = Object.freeze({bind, wheelModes: Object.freeze([...WHEEL_MODES])});
})(window);
