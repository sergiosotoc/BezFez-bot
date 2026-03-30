/* src/bot/sender.js */
import { logger } from '../config/logger.js';

export class Sender {
  constructor(sock) {
    this.sock = sock;
  }

  async sendText(jid, text) {
    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err) {
      logger.error({ jid, err: err.message }, 'Error enviando mensaje de texto');
      throw err;
    }
  }

  async sendImage(jid, buffer, caption = '') {
    try {
      await this.sock.sendMessage(jid, { image: buffer, caption });
    } catch (err) {
      logger.error({ jid, err: err.message }, 'Error enviando imagen');
      throw err;
    }
  }

  async sendDocument(jid, buffer, filename, caption = '') {
    try {
      await this.sock.sendMessage(jid, {
        document: buffer,
        mimetype: 'application/pdf',
        fileName: filename,
        caption,
      });
    } catch (err) {
      logger.error({ jid, err: err.message }, 'Error enviando documento');
      throw err;
    }
  }

  async forwardMessage(toJid, message, caption) {
    try {
      if (caption) {
        await this.sendText(toJid, caption);
      }
      await this.sock.sendMessage(toJid, { forward: message });
    } catch (err) {
      logger.error({ toJid, err: err.message }, 'Error reenviando mensaje');
      throw err;
    }
  }

  async markRead(jid, messageIds) {
    try {
      await this.sock.readMessages(
        messageIds.map(id => ({ remoteJid: jid, id }))
      );
    } catch {
    }
  }
}
