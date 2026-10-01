'use strict';

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toBody() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

module.exports = { HttpError };
