import * as https from "https";
import * as http from "http";
import * as R from "ramda";

export interface Request {
  method: string;
  path: string;
  headers: { [key: string]: string | string[] | undefined };
  query?: any;
  body?: string;
}

export class HttpError extends Error {
  constructor(public statusCode: number, message?: string, public body: any = null) {
    super(message);
  }
}

export interface Response {
  statusCode: number;
  headers: any;
  body: any;
}

type RequestHandler<U> = ((rq: Request, auth: () => Promise<U>) => Promise<Response>);
type Methods<U> = { [key: string]: RequestHandler<U> };
type Children<U> = R.Dictionary<ServiceNode<U>>;

export interface ServiceNode<U> {
  methods: Methods<U>;
  children: Children<U>;
}

export function makeRequest(options: http.RequestOptions, postData?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const rq: http.ClientRequest = https.request(options, (res: http.IncomingMessage) => {
      const body: string[] = [];

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body.push(chunk);
      });
      res.on("end", () => {
        const result: string = body.join("");
        resolve({
          statusCode: res.statusCode || 500,
          headers: {},
          body: result.length == 0 ? null : JSON.parse(result),
        });
      });
    });
    rq.on("error", (e: Error) => {
      reject(e);
    });
    if (postData) {
      rq.write(postData);
    }
    rq.end();
  });
}

export const json = <U>(value: any, children: Children<U> = {}): ServiceNode<U> => ({
  methods: {
    GET: async () => ({ statusCode: 200, headers: {}, body: value }),
  },
  children,
});

export const httpNode = <U>(methods: Methods<U>, children: Children<U>): ServiceNode<U> => ({ methods, children });

export const directory = <U>(children: Children<U>) =>
  httpNode({ GET: async () => ({ statusCode: 200, headers: {}, body: "directory" }) }, children);

export const httpPost = <U>(handler: RequestHandler<U>) => httpNode({ POST: handler }, {});
export const httpGet = <U>(handler: RequestHandler<U>) => httpNode({ GET: handler }, {});
export const httpPut = <U>(handler: RequestHandler<U>) => httpNode({ PUT: handler }, {});

const invoke = <U>(node: ServiceNode<U>, tag: string): ServiceNode<U> => {
  if (node.children === null || node.children === undefined) {
    throw new HttpError(404, "Illegal node parent. Missing children.");
  }
  const fn = node.children[tag];
  if (fn === undefined) {
    throw new HttpError(404, `Resource not found: ${tag}. Did you mean ${Object.keys(node.children)}?`);
  }
  return fn;
};

const getQueryResult = <U>(node: ServiceNode<U>, paths: string[], index: number): ServiceNode<U> => {
  if (index === paths.length) {
    return node;
  }
  const result = invoke(node, paths[index]);
  return getQueryResult(result, paths, index + 1);
};

export const readValues = (str: string) => {
  // a=1&b=2&c=8
  if (str.length === 0) {
    return {};
  }
  const parts = str.split("&");
  const values: { [key: string]: any } = {};
  for (let i = 0; i < parts.length; i += 1) {
    const keys = parts[i].split("=");
    values[keys[0]] = keys[1];
  }
  return values;
};

export const getRequestData = (request: Request) => {
  switch (request.method) {
    case "GET":
    case "DELETE":
      return request.query;
    default:
      return request.body && request.body.length > 0 && JSON.parse(request.body);
  }
};

export const parsePath = (str: string): { path: string; query?: any } => {
  // tag?query
  const k = str.indexOf("?");
  if (k === -1) {
    return { path: str, query: null };
  }
  return {
    path: str.substr(0, k),
    query: readValues(str.substr(k + 1)),
  };
};

export const readParts = (path: string): string[] => {
  if (path === null || path === undefined || path.length === 0) {
    return [];
  }
  return path.substr(1).split("/");
};

export const options = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Auth-Provider",
  "Access-Control-Allow-Methods": "OPTIONS, GET, POST, PUT",
  "Content-Type": "application/json",
};

const getError = (error: Error) => {
  if (error instanceof HttpError) {
    return error;
  }
  const e = error as any;
  if (e.statusCode) {
    return new HttpError(e.statusCode, e.message, e.body);
  }
  console.log("Caught an unknown error: " + (error ? error.message : null));
  console.log("Error", error);
  console.log("Error type", typeof error);
  console.error(error);
  return new HttpError(500, error.message);
};

export const handleRequest = <U>(root: ServiceNode<U>) => (
  auth: () => Promise<U>,
  request: Request,
  callback: (code: number, header: any, body: any) => void,
) => {
  const returnError = (error: Error) => {
    const httpError: HttpError = getError(error);
    callback(httpError.statusCode, options, {
      request,
      message: httpError.message,
      body: httpError.body,
    });
  };
  const returnResponse = (response: Response) => {
    callback(200, { ...options, ...response.headers }, response.body);
  };
  try {
    const paths = readParts(request.path);
    const node: ServiceNode<U> = getQueryResult(root, paths, 0);
    const method = node.methods[request.method];
    if (method) {
      method(request, auth)
        .then(returnResponse)
        .catch(returnError);
    } else if (request.method === "OPTIONS") {
      callback(200, options, {});
    } else {
      callback(404, options, {});
    }
  } catch (error) {
    returnError(error);
  }
};

export const authenticate = <U, Result>(handler: (user: U, request: Request) => Result) => async (
  request: Request,
  auth: () => Promise<U>,
) => {
  const user = await auth();
  const result = await handler(user, request);
  return { statusCode: 200, headers: {}, body: result };
};
