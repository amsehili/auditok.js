/**
 * StreamTokenizer: the event-shaping state machine at the heart of
 * auditok, ported line for line from the Python implementation. It is
 * generic over the frame type — frames can be analysis windows of
 * audio, characters, booleans from another VAD's frame decisions —
 * and turns per-frame valid/invalid decisions into tokens with
 * min/max length and silence semantics.
 */

export type FrameValidator<T> =
  | ((frame: T) => boolean)
  | { isValid(frame: T): boolean };

export interface Token<T> {
  frames: T[];
  /** Index of the first frame of the token in the input stream. */
  start: number;
  /** Index of the last frame of the token in the input stream. */
  end: number;
}

export interface StreamTokenizerOptions {
  /** Minimum number of frames in a valid token, including any
   * tolerated non-valid frames within the token. */
  minLength: number;
  /** Maximum number of frames in a valid token. Use Infinity for no
   * limit. */
  maxLength: number;
  /** Maximum number of consecutive non-valid frames within a token. */
  maxContinuousSilence: number;
  /** Maximum number of non-valid frames to retain immediately before
   * the first valid frame of each token; the token's start position is
   * adjusted backward accordingly. Default 0. */
  maxLeadingSilence?: number;
  /** Maximum number of trailing non-valid frames to keep at the end of
   * each token. `null` (default) keeps all trailing silence up to
   * `maxContinuousSilence`; `0` drops it entirely; a value larger than
   * `maxContinuousSilence` keeps collecting silent frames past the
   * event boundary (stopping early on a valid frame or end of data). */
  maxTrailingSilence?: number | null;
  /** Reject tokens shorter than `minLength` even when they immediately
   * follow a token delivered at `maxLength`. Default false. */
  strictMinLength?: boolean;
  /** Minimum number of consecutive valid frames required before
   * tolerating non-valid ones. Default 0 (rarely needed; prefer
   * `maxLeadingSilence`). */
  initMin?: number;
  /** Maximum tolerated consecutive non-valid frames before reaching
   * `initMin`. Default 0. */
  initMaxSilence?: number;
}

const SILENCE = 0;
const POSSIBLE_SILENCE = 1;
const POSSIBLE_NOISE = 2;
const NOISE = 3;
const TRAILING_COLLECTION = 4;

export class StreamTokenizer<T> {
  readonly minLength: number;
  readonly maxLength: number;
  readonly maxContinuousSilence: number;
  readonly maxLeadingSilence: number;
  readonly maxTrailingSilence: number | null;
  readonly strictMinLength: boolean;
  readonly initMin: number;
  readonly initMaxSilence: number;

  private readonly isValid: (frame: T) => boolean;
  private readonly needsTrailingExtension: boolean;

  private state = SILENCE;
  private data: T[] = [];
  private leadingBuffer: T[] = [];
  private contiguousToken = false;
  private initCount = 0;
  private silenceLength = 0;
  private startFrame = 0;
  private currentFrame = -1;

  constructor(validator: FrameValidator<T>, options: StreamTokenizerOptions) {
    if (typeof validator === "function") {
      this.isValid = validator;
    } else if (validator && typeof validator.isValid === "function") {
      this.isValid = validator.isValid.bind(validator);
    } else {
      throw new TypeError(
        "'validator' must be a function or an object with an isValid method",
      );
    }

    const {
      minLength,
      maxLength,
      maxContinuousSilence,
      maxLeadingSilence = 0,
      maxTrailingSilence = null,
      strictMinLength = false,
      initMin = 0,
      initMaxSilence = 0,
    } = options;

    if (maxLength <= 0) {
      throw new RangeError(`'maxLength' must be > 0 (value=${maxLength})`);
    }
    if (minLength <= 0 || minLength > maxLength) {
      throw new RangeError(
        `'minLength' must be > 0 and <= 'maxLength' (value=${minLength})`,
      );
    }
    if (maxContinuousSilence >= maxLength) {
      throw new RangeError(
        `'maxContinuousSilence' must be < 'maxLength' ` +
          `(value=${maxContinuousSilence})`,
      );
    }
    if (initMin >= maxLength) {
      throw new RangeError(`'initMin' must be < 'maxLength' (value=${initMin})`);
    }

    this.minLength = minLength;
    this.maxLength = maxLength;
    this.maxContinuousSilence = maxContinuousSilence;
    this.maxLeadingSilence = maxLeadingSilence;
    this.maxTrailingSilence = maxTrailingSilence;
    this.strictMinLength = strictMinLength;
    this.initMin = initMin;
    this.initMaxSilence = initMaxSilence;
    this.needsTrailingExtension =
      maxTrailingSilence !== null &&
      maxTrailingSilence > maxContinuousSilence;
  }

  /**
   * Tokenize `source` frame by frame, yielding tokens as soon as their
   * end is decided. Accepts both sync and async iterables.
   */
  async *tokenize(
    source: Iterable<T> | AsyncIterable<T>,
  ): AsyncGenerator<Token<T>, void, void> {
    this.reinitialize();
    for await (const frame of source) {
      this.currentFrame += 1;
      const token = this.process(frame);
      if (token !== undefined) {
        yield token;
      }
    }
    this.currentFrame += 1;
    const token = this.postProcess();
    if (token !== undefined) {
      yield token;
    }
  }

  /** Convenience wrapper collecting all tokens into an array. */
  async tokenizeAll(
    source: Iterable<T> | AsyncIterable<T>,
  ): Promise<Token<T>[]> {
    const tokens: Token<T>[] = [];
    for await (const token of this.tokenize(source)) {
      tokens.push(token);
    }
    return tokens;
  }

  private reinitialize(): void {
    this.contiguousToken = false;
    this.data = [];
    this.state = SILENCE;
    this.currentFrame = -1;
    this.initCount = 0;
    this.silenceLength = 0;
    this.startFrame = 0;
    this.leadingBuffer = [];
  }

  private pushLeading(frame: T): void {
    if (this.maxLeadingSilence <= 0) {
      return;
    }
    this.leadingBuffer.push(frame);
    if (this.leadingBuffer.length > this.maxLeadingSilence) {
      this.leadingBuffer.shift();
    }
  }

  private startToken(frame: T): void {
    const leading = this.leadingBuffer;
    this.leadingBuffer = [];
    this.initCount = 1;
    this.silenceLength = 0;
    this.startFrame = this.currentFrame - leading.length;
    this.data = [...leading, frame];
  }

  private process(frame: T): Token<T> | undefined {
    const frameIsValid = this.isValid(frame);

    if (this.state === SILENCE) {
      if (frameIsValid) {
        // seems we got a valid frame after a silence
        this.startToken(frame);
        if (this.initCount >= this.initMin) {
          this.state = NOISE;
          if (this.data.length >= this.maxLength) {
            return this.processEndOfDetection(true);
          }
        } else {
          this.state = POSSIBLE_NOISE;
        }
      } else {
        this.pushLeading(frame);
      }
      return undefined;
    }

    if (this.state === POSSIBLE_NOISE) {
      if (frameIsValid) {
        this.silenceLength = 0;
        this.initCount += 1;
        this.data.push(frame);
        if (this.initCount >= this.initMin) {
          this.state = NOISE;
          if (this.data.length >= this.maxLength) {
            return this.processEndOfDetection(true);
          }
        }
      } else {
        this.silenceLength += 1;
        if (
          this.silenceLength > this.initMaxSilence ||
          this.data.length + 1 >= this.maxLength
        ) {
          // either initMaxSilence or maxLength is reached before
          // initCount, back to silence
          this.data = [];
          this.state = SILENCE;
        } else {
          this.data.push(frame);
        }
      }
      return undefined;
    }

    if (this.state === NOISE) {
      if (frameIsValid) {
        this.data.push(frame);
        if (this.data.length >= this.maxLength) {
          return this.processEndOfDetection(true);
        }
      } else if (this.maxContinuousSilence <= 0) {
        if (this.needsTrailingExtension) {
          this.data.push(frame);
          this.silenceLength = 1;
          this.state = TRAILING_COLLECTION;
          if (this.data.length >= this.maxLength) {
            this.state = SILENCE;
            return this.processEndOfDetection();
          }
        } else {
          this.state = SILENCE;
          const token = this.processEndOfDetection();
          this.pushLeading(frame);
          return token;
        }
      } else {
        // this is the first silent frame following a valid one and it
        // is tolerated
        this.silenceLength = 1;
        this.data.push(frame);
        this.state = POSSIBLE_SILENCE;
        if (this.data.length === this.maxLength) {
          return this.processEndOfDetection(true);
          // don't reset silenceLength because we still need to know
          // the total number of silent frames
        }
      }
      return undefined;
    }

    if (this.state === POSSIBLE_SILENCE) {
      if (frameIsValid) {
        this.data.push(frame);
        this.silenceLength = 0;
        this.state = NOISE;
        if (this.data.length >= this.maxLength) {
          return this.processEndOfDetection(true);
        }
      } else {
        if (this.silenceLength >= this.maxContinuousSilence) {
          if (
            this.needsTrailingExtension &&
            this.silenceLength < this.data.length
          ) {
            // continue collecting trailing beyond maxContinuousSilence
            this.data.push(frame);
            this.silenceLength += 1;
            this.state = TRAILING_COLLECTION;
            if (
              this.silenceLength >= (this.maxTrailingSilence as number) ||
              this.data.length >= this.maxLength
            ) {
              this.state = SILENCE;
              return this.processEndOfDetection();
            }
          } else {
            this.state = SILENCE;
            if (this.silenceLength < this.data.length) {
              const token = this.processEndOfDetection();
              this.pushLeading(frame);
              return token;
            }
            this.data = [];
            this.silenceLength = 0;
            this.pushLeading(frame);
          }
        } else {
          this.data.push(frame);
          this.silenceLength += 1;
          if (this.data.length >= this.maxLength) {
            return this.processEndOfDetection(true);
            // don't reset silenceLength because we still need to know
            // the total number of silent frames
          }
        }
      }
      return undefined;
    }

    // state === TRAILING_COLLECTION
    if (frameIsValid) {
      // event is over: deliver with collected trailing, then start a
      // new token from this valid frame
      const token = this.processEndOfDetection();
      this.startToken(frame);
      this.state = this.initCount >= this.initMin ? NOISE : POSSIBLE_NOISE;
      return token;
    }
    this.data.push(frame);
    this.silenceLength += 1;
    if (
      this.silenceLength >= (this.maxTrailingSilence as number) ||
      this.data.length >= this.maxLength
    ) {
      this.state = SILENCE;
      return this.processEndOfDetection();
    }
    return undefined;
  }

  private postProcess(): Token<T> | undefined {
    if (
      this.state === NOISE ||
      this.state === POSSIBLE_SILENCE ||
      this.state === TRAILING_COLLECTION
    ) {
      if (this.data.length > 0 && this.data.length > this.silenceLength) {
        return this.processEndOfDetection();
      }
    }
    return undefined;
  }

  private processEndOfDetection(truncated = false): Token<T> | undefined {
    if (
      !truncated &&
      this.maxTrailingSilence !== null &&
      this.silenceLength > this.maxTrailingSilence
    ) {
      // Trim trailing silence beyond the allowed amount. Happens if
      // maxContinuousSilence is reached or maxLength is reached at a
      // silent frame. Trimmed frames are seeded into the leading
      // buffer so they can become leading silence for the next token.
      const excess = this.silenceLength - this.maxTrailingSilence;
      const trimStart = Math.max(0, this.data.length - excess);
      const trimmed = this.data.splice(trimStart);
      for (const frame of trimmed) {
        this.pushLeading(frame);
      }
    }

    if (
      this.data.length >= this.minLength ||
      (this.data.length > 0 && !this.strictMinLength && this.contiguousToken)
    ) {
      const token: Token<T> = {
        frames: this.data,
        start: this.startFrame,
        end: this.startFrame + this.data.length - 1,
      };
      this.data = [];
      if (truncated) {
        // next token (if any) will start at currentFrame + 1 and is
        // contiguous with the just delivered one
        this.startFrame = this.currentFrame + 1;
        this.contiguousToken = true;
      } else {
        this.contiguousToken = false;
      }
      return token;
    }

    this.contiguousToken = false;
    this.data = [];
    return undefined;
  }
}
