export class ChatterPointsBusinessException extends Error {
  public readonly code: string;

  public readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'ChatterPointsBusinessException';
    this.code = code;
    this.status = status;
  }

  static invalidGuessLength(expectedLength: number): ChatterPointsBusinessException {
    return new ChatterPointsBusinessException(
      `Invalid guess length. Expected ${expectedLength} letters.`,
      'INVALID_GUESS_LENGTH',
      400
    );
  }

  static noWordForLanguage(lang: string): ChatterPointsBusinessException {
    return new ChatterPointsBusinessException(
      `No word available for language=${lang} in this period.`,
      'NO_WORD_FOR_LANGUAGE',
      404
    );
  }
}
