/**
 * Minimal stdout logger mirroring Python's `logging.basicConfig(level=logging.INFO)`
 * output shape: LEVEL:name:message
 */
export class Logger {
  constructor(private readonly name: string) {}

  private emit(level: string, message: string): void {
    const line = `${level}:${this.name}:${message}`;
    if (level === 'ERROR' || level === 'WARNING') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  info(message: string): void {
    this.emit('INFO', message);
  }

  warning(message: string): void {
    this.emit('WARNING', message);
  }

  error(message: string): void {
    this.emit('ERROR', message);
  }

  debug(message: string): void {
    if (process.env.LOG_LEVEL === 'DEBUG') this.emit('DEBUG', message);
  }
}

export function getLogger(name: string): Logger {
  return new Logger(name);
}

/** Format an unknown thrown value the way Python's `str(e)` would read. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
