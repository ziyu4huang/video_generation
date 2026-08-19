// A small SystemVerilog counter used as the analyzer's self-test fixture.
`default_nettype none

module counter #(
    parameter int WIDTH = 8
) (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        en,
    output logic [WIDTH-1:0] count,
    output logic       overflow
);

    logic [WIDTH-1:0] next_count;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            count <= '0;
        end else if (en) begin
            count <= next_count;
        end
    end

    assign next_count = count + 1'b1;
    assign overflow = &count;

    reg_sync sync_inst (
        .clk(clk),
        .d(count),
        .q(count)
    );

endmodule

module reg_sync (
    input  wire clk,
    input  wire [WIDTH-1:0] d,
    output logic [WIDTH-1:0] q
);
    always_ff @(posedge clk) begin
        q <= d;
    end
endmodule
