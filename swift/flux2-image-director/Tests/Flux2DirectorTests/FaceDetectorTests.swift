import XCTest
@testable import Flux2Director

final class FaceDetectorTests: XCTestCase {

    // MARK: - expandBBox (pure logic, no fixture needed)

    func testExpandBBoxDoublesSizeAroundCenter() {
        let box = FaceBoundingBox(x1: 100, y1: 100, x2: 200, y2: 200)
        let expanded = FaceDetector.expandBBox(box, padding: 2.0, imgW: 1000, imgH: 1000)
        XCTAssertEqual(expanded, FaceBoundingBox(x1: 50, y1: 50, x2: 250, y2: 250))
    }

    func testExpandBBoxClampsToImageBounds() {
        let box = FaceBoundingBox(x1: 10, y1: 10, x2: 60, y2: 60)
        let expanded = FaceDetector.expandBBox(box, padding: 3.0, imgW: 100, imgH: 100)
        XCTAssertEqual(expanded.x1, 0)
        XCTAssertEqual(expanded.y1, 0)
        XCTAssertLessThanOrEqual(expanded.x2, 100)
        XCTAssertLessThanOrEqual(expanded.y2, 100)
    }

    func testExpandBBoxForcesEvenDimensions() {
        // width = (101-0) * 1.0 = 101 -> 101 & ~1 = 100 (even)
        let box = FaceBoundingBox(x1: 0, y1: 0, x2: 101, y2: 101)
        let expanded = FaceDetector.expandBBox(box, padding: 1.0, imgW: 1000, imgH: 1000)
        XCTAssertEqual((expanded.x2 - expanded.x1) % 2, 0)
        XCTAssertEqual((expanded.y2 - expanded.y1) % 2, 0)
    }

    // MARK: - detectFaces (real Vision detection against a git-tracked fixture)

    private var fixtureURL: URL {
        // Tests run with CWD = the package root (swift/flux2-image-director);
        // walk up to the repo root, same discipline as CutoutCommand.swift's
        // runSAM3Bridge python-venv lookup.
        var dir = FileManager.default.currentDirectoryPath
        for _ in 0..<8 {
            let candidate = (dir as NSString).appendingPathComponent(
                "scripts/fixtures/faces/real_face_portrait.png")
            if FileManager.default.fileExists(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return URL(fileURLWithPath: dir)
    }

    func testDetectFacesFindsRealFaceInFixtureImage() throws {
        let url = fixtureURL
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path),
                           "fixture image not found — expected scripts/fixtures/faces/real_face_portrait.png")

        let faces = try FaceDetector.detectFaces(at: url, width: 832, height: 1024)

        XCTAssertGreaterThanOrEqual(faces.count, 1, "expected at least one face detected in the fixture image")
        for face in faces {
            XCTAssertGreaterThan(face.x2, face.x1)
            XCTAssertGreaterThan(face.y2, face.y1)
            XCTAssertGreaterThanOrEqual(face.x1, 0)
            XCTAssertGreaterThanOrEqual(face.y1, 0)
            XCTAssertLessThanOrEqual(face.x2, 832)
            XCTAssertLessThanOrEqual(face.y2, 1024)
        }
    }
}
