export interface Issue {
  path: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues?: Issue[],
  ) {
    super(message);
  }
}

export const badRequest = (message: string, issues?: Issue[]) =>
  new HttpError(400, "invalid_request", message, issues);
export const notFound = (message: string) => new HttpError(404, "not_found", message);
