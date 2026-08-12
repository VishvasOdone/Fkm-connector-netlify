/**
 * Minimal stdout logger mirroring Python's `logging.basicConfig(level=logging.INFO)`
 * output shape: LEVEL:name:message
 */
export class Logger {
    name;
    constructor(name) {
        this.name = name;
    }
    emit(level, message) {
        const line = `${level}:${this.name}:${message}`;
        if (level === 'ERROR' || level === 'WARNING') {
            console.error(line);
        }
        else {
            console.log(line);
        }
    }
    info(message) {
        this.emit('INFO', message);
    }
    warning(message) {
        this.emit('WARNING', message);
    }
    error(message) {
        this.emit('ERROR', message);
    }
    debug(message) {
        if (process.env.LOG_LEVEL === 'DEBUG')
            this.emit('DEBUG', message);
    }
}
export function getLogger(name) {
    return new Logger(name);
}
/** Format an unknown thrown value the way Python's `str(e)` would read. */
export function errText(e) {
    if (e instanceof Error)
        return e.message;
    return String(e);
}
//# sourceMappingURL=logger.js.map