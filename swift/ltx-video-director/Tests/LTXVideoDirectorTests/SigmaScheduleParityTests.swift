import XCTest
@testable import LTXVideoDirector

/// Numerical parity check against ltx_pipelines_mlx.scheduler's
/// DISTILLED_SIGMAS/STAGE_2_SIGMAS (literal tables) and ltx2_schedule
/// (mlx_arsenal.diffusion.dynamic_shift_schedule) — see
/// scripts/dump_sigma_schedule_reference.py, PLAN.md Phase 3.
final class SigmaScheduleParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/sigma_schedule")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/sigma_schedule")
    }

    private func loadSchedules() throws -> [String: [Double]] {
        let data = try Data(contentsOf: refsDir.appendingPathComponent("schedules.json"))
        return try JSONDecoder().decode([String: [Double]].self, from: data)
    }

    private func assertClose(_ actual: [Float], _ expected: [Double], tol: Float = 1e-5, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.count, expected.count, file: file, line: line)
        for (a, e) in zip(actual, expected) {
            XCTAssertEqual(a, Float(e), accuracy: tol, file: file, line: line)
        }
    }

    func testLiteralTables() throws {
        let schedules = try loadSchedules()
        assertClose(SigmaSchedule.distilledSigmas, schedules["distilled_sigmas"]!)
        assertClose(SigmaSchedule.stage2Sigmas, schedules["stage_2_sigmas"]!)
    }

    func testDynamicShiftSchedule8Step4096Tokens() throws {
        let schedules = try loadSchedules()
        let actual = SigmaSchedule.ltx2Schedule(steps: 8, numTokens: 4096)
        assertClose(actual, schedules["ltx2_8step_4096tok"]!)
    }

    func testDynamicShiftSchedule20Step1024Tokens() throws {
        let schedules = try loadSchedules()
        let actual = SigmaSchedule.ltx2Schedule(steps: 20, numTokens: 1024)
        assertClose(actual, schedules["ltx2_20step_1024tok"]!)
    }

    func testDynamicShiftScheduleNoStretch() throws {
        let schedules = try loadSchedules()
        let actual = SigmaSchedule.ltx2Schedule(steps: 3, numTokens: 2000, stretch: false)
        assertClose(actual, schedules["ltx2_3step_2000tok_nostretch"]!)
    }
}
