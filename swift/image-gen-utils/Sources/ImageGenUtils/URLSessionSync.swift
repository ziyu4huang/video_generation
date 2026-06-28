//
//  URLSessionSync.swift
//  ImageGenUtils
//
//  Synchronous URLRequest helper (semaphore-waited) for blocking CLI tools.
//  The image-gen directors are command-line tools that need a straightforward
//  blocking POST to LM Studio; this wraps URLSession's async API for that.
//

import Foundation

extension URLSession {
    /// Run a URLRequest synchronously (semaphore-waited). For CLI use only —
    /// never call from a GUI/main thread context.
    func synchronously(_ request: URLRequest) throws -> (Data, URLResponse) {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(Data, URLResponse), Error>!
        let task = self.dataTask(with: request) { data, response, error in
            if let error = error {
                result = .failure(error)
            } else {
                result = .success((data ?? Data(), response!))
            }
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()
        return try result.get()
    }
}
