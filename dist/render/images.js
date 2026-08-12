/**
 * Resolves the images behind a sheet's figures.
 *
 * o-spreadsheet stores an inserted image as a figure whose `data.path` is an
 * Odoo image URL ("/web/image/743"). The bytes are fetched over RPC from
 * `ir.attachment` rather than over HTTP, because the JSON-RPC credentials
 * already work and no session cookie is needed.
 *
 * Two failure modes are expected in real data and are handled, not thrown:
 *
 *  - the attachment is gone (the figure outlived the image, or the workbook was
 *    imported from another database), and
 *  - the id has been REUSED by an unrelated record. Attachment ids are a plain
 *    sequence, so a deleted image's id later belongs to a snapshot, a CSS
 *    bundle or a JS asset. Embedding those bytes would put a corrupt image in
 *    the workbook, so the mimetype is verified before anything is embedded.
 */
import { decode as decodeWebp } from '@cwasm/webp';
import { getLogger, errText } from '../logger.js';
import { encodePng } from './png.js';
const logger = getLogger('images');
/** Formats Excel embeds directly; anything else is converted or skipped. */
const PASSTHROUGH = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/gif': 'gif',
};
/**
 * Attachment id out of an Odoo image URL. Handles the plain form
 * ("/web/image/743"), the cache-busting form ("/web/image/743-a1b2c3/logo.png")
 * and the model form ("/web/image/ir.attachment/743/datas").
 */
export function attachmentIdFromPath(path) {
    const parts = String(path).split('?')[0].split('/').filter(Boolean);
    const at = parts.indexOf('image');
    if (at < 0)
        return null;
    for (const part of parts.slice(at + 1)) {
        const id = parseInt(part.split('-')[0], 10);
        if (Number.isFinite(id) && id > 0)
            return id;
    }
    return null;
}
/** Decode a WebP payload into a PNG; every other image type passes through. */
function toEmbeddable(mimetype, bytes) {
    const mime = mimetype.toLowerCase();
    const direct = PASSTHROUGH[mime];
    if (direct)
        return { buffer: bytes, extension: direct };
    if (mime === 'image/webp') {
        const { width, height, data } = decodeWebp(bytes);
        return { buffer: encodePng(width, height, data), extension: 'png' };
    }
    return null;
}
/**
 * Fetch and convert every image the model's figures point at, keyed by figure
 * path. Figures whose image cannot be resolved are simply absent from the map;
 * the emitter skips them and the sheet keeps the empty space.
 */
export async function loadFigureImages(odoo, model) {
    const out = new Map();
    const pathById = new Map();
    let unparseable = 0;
    for (const sheet of model.sheets) {
        for (const fig of sheet.figures) {
            const id = attachmentIdFromPath(fig.path);
            if (id === null) {
                unparseable += 1;
                continue;
            }
            const paths = pathById.get(id);
            if (paths)
                paths.push(fig.path);
            else
                pathById.set(id, [fig.path]);
        }
    }
    if (!pathById.size) {
        if (unparseable) {
            logger.warning(`${unparseable} figure(s) had an image path we cannot parse; skipped.`);
        }
        return out;
    }
    const ids = [...pathById.keys()];
    // Read the metadata first: it is small, and it decides which (potentially
    // multi-megabyte) payloads are worth fetching at all.
    let records;
    try {
        records = await odoo.call('ir.attachment', 'search_read', [
            [['id', 'in', ids]],
            ['id', 'mimetype', 'name'],
        ]);
    }
    catch (e) {
        logger.error(`Could not read image attachments; sheets will have no images: ${errText(e)}`);
        return out;
    }
    const usable = [];
    const mimeById = new Map();
    const wrongType = [];
    for (const rec of records) {
        const id = rec.id;
        const mime = String(rec.mimetype ?? '');
        if (!mime.startsWith('image/')) {
            // The id now belongs to something that is not an image.
            wrongType.push(`#${id} (${mime || 'no mimetype'}, "${String(rec.name ?? '')}")`);
            continue;
        }
        mimeById.set(id, mime);
        usable.push(id);
    }
    const missing = ids.filter((id) => !records.some((r) => r.id === id));
    if (usable.length) {
        try {
            const payloads = await odoo.call('ir.attachment', 'read', [
                usable,
                ['id', 'datas'],
            ]);
            for (const rec of payloads) {
                const id = rec.id;
                const datas = rec.datas;
                if (typeof datas !== 'string' || !datas)
                    continue;
                const mime = mimeById.get(id) ?? '';
                let image = null;
                try {
                    image = toEmbeddable(mime, Buffer.from(datas, 'base64'));
                }
                catch (e) {
                    logger.warning(`Image attachment #${id} (${mime}) could not be decoded: ${errText(e)}`);
                    continue;
                }
                if (!image) {
                    logger.warning(`Image attachment #${id} has unsupported type ${mime}; skipped.`);
                    continue;
                }
                for (const path of pathById.get(id) ?? [])
                    out.set(path, image);
            }
        }
        catch (e) {
            logger.error(`Could not fetch image bytes; sheets will have no images: ${errText(e)}`);
        }
    }
    // One summary line: a sheet quietly missing its drawings is worth noticing,
    // but a broken figure is a data problem in Odoo, not a reason to fail.
    const resolved = out.size;
    if (missing.length || wrongType.length || unparseable) {
        logger.warning(`Figure images: ${resolved}/${pathById.size} resolved. ` +
            `${missing.length} attachment(s) no longer exist (${missing.slice(0, 10).join(', ')}); ` +
            `${wrongType.length} id(s) now belong to a non-image record — id reuse, skipped ` +
            `(${wrongType.slice(0, 5).join('; ')})` +
            (unparseable ? `; ${unparseable} unparseable path(s)` : ''));
    }
    else {
        logger.info(`Figure images: ${resolved}/${pathById.size} resolved.`);
    }
    return out;
}
//# sourceMappingURL=images.js.map