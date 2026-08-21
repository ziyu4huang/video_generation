// i2c_bus.sv — I2C design + testbench used to exercise the dsh-sv-analyzer.
//
// Contains three design units:
//   i2c_master   — parameterized I2C controller: quarter-period clock
//                  divider, START/STOP generation, 7-bit addressing,
//                  single-byte write/read with ACK sampling.
//   i2c_slave    — address-matching slave: 7-bit address, 8-bit shift
//                  register, ACK/NACK on the bus.
//   i2c_master_tb — self-checking testbench: clock gen, stimulus tasks, and
//                  a master + slave wired onto a shared two-wire bus.
//
// Open-drain drivers are modelled as tri-state with `assign scl = oe ? 1'b0 :
// 1'bz`; external pull-ups are assumed (I2C standard).

`default_nettype none
`timescale 1ns/1ps

// ---------------------------------------------------------------------------
// I2C master
// ---------------------------------------------------------------------------
module i2c_master #(
    parameter int CLK_HZ = 100_000_000,
    parameter int I2C_HZ = 400_000,
    parameter int ADDR_W = 7,
    parameter int DATA_W = 8
) (
    input  wire              clk,
    input  wire              rst_n,

    // host control interface
    input  wire              start,          // one-cycle pulse: begin transfer
    input  wire              rw,             // 1 = read from slave, 0 = write
    input  wire [ADDR_W-1:0] dev_addr,       // 7-bit slave address
    input  wire [DATA_W-1:0] tx_data,        // byte to write
    output logic [DATA_W-1:0] rx_data,       // byte read back
    output logic             busy,
    output logic             done,
    output logic             ack_err,

    // I2C bus (open-drain, pull-ups external)
    inout  wire              scl,
    inout  wire              sda
);

    // One quarter of an SCL half-period in host clock cycles.
    localparam int QUARTER = (CLK_HZ / I2C_HZ) / 4;

    typedef enum logic [2:0] {
        IDLE,
        START,
        TRANSFER,
        ACK,
        STOP
    } state_t;

    state_t                state;
    logic [3:0]            tick;
    logic [ADDR_W+DATA_W:0] shift;          // {addr, rw, data} bit stream
    logic [3:0]            bit_idx;
    logic                  scl_oe;
    logic                  sda_oe;
    logic                  sda_val;
    logic                  sda_sampled;

    // Bus I/O: open-drain drivers + SDA sampling on the rising SCL edge.
    assign scl = scl_oe ? 1'b0 : 1'bz;
    assign sda = sda_oe ? sda_val : 1'bz;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tick <= '0;
        end else if (tick == QUARTER - 1) begin
            tick <= '0;
        end else begin
            tick <= tick + 1'b1;
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state     <= IDLE;
            scl_oe    <= 1'b0;
            sda_oe    <= 1'b0;
            sda_val   <= 1'b1;
            busy      <= 1'b0;
            done      <= 1'b0;
            ack_err   <= 1'b0;
            rx_data   <= '0;
            bit_idx   <= '0;
        end else begin
            case (state)
                IDLE: begin
                    done <= 1'b0;
                    if (start && !busy) begin
                        busy    <= 1'b1;
                        sda_oe  <= 1'b1;
                        sda_val <= 1'b0;    // SDA falls while SCL high: START
                        state   <= START;
                    end
                end

                START: begin
                    scl_oe <= 1'b1;         // pull SCL low to begin bit clock
                    shift  <= {dev_addr, rw, tx_data};
                    bit_idx <= ADDR_W + DATA_W;
                    state  <= TRANSFER;
                end

                TRANSFER: begin
                    scl_oe <= 1'b1;
                    sda_oe <= 1'b1;
                    sda_val <= shift[bit_idx];
                    if (bit_idx == 0) begin
                        sda_oe <= 1'b0;     // release SDA: ACK slot
                        state  <= ACK;
                    end else begin
                        bit_idx <= bit_idx - 1'b1;
                    end
                end

                ACK: begin
                    scl_oe <= 1'b1;
                    sda_oe <= 1'b0;
                    sda_sampled <= sda;
                    if (sda_sampled != 1'b0) begin
                        ack_err <= 1'b1;
                        state   <= STOP;
                    end else if (rw) begin
                        state   <= TRANSFER;
                        bit_idx <= DATA_W - 1;
                    end else begin
                        state <= STOP;
                    end
                end

                STOP: begin
                    scl_oe <= 1'b0;         // release SCL high
                    sda_oe <= 1'b1;
                    sda_val <= 1'b0;
                    if (sda_sampled) begin
                        // SDA rises while SCL high: STOP condition
                    end
                    busy    <= 1'b0;
                    done    <= 1'b1;
                    sda_oe  <= 1'b0;
                    sda_val <= 1'b1;
                    state   <= IDLE;
                end

                default: state <= IDLE;
            endcase
        end
    end

endmodule

// ---------------------------------------------------------------------------
// I2C slave (7-bit address, byte write/read)
// ---------------------------------------------------------------------------
module i2c_slave #(
    parameter int ADDR_W = 7,
    parameter int DATA_W = 8
) (
    input  wire              clk,
    input  wire              rst_n,
    input  wire [ADDR_W-1:0] my_addr,
    input  wire              scl,
    inout  wire              sda,
    output logic [DATA_W-1:0] reg_out
);

    logic [ADDR_W+DATA_W:0] shift;
    logic [3:0]             bit_idx;
    logic                   got_start;
    logic                   matched;
    logic                   sda_oe;

    assign sda = sda_oe ? 1'b0 : 1'bz;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            shift    <= '0;
            bit_idx  <= '0;
            got_start <= 1'b0;
            matched  <= 1'b0;
            sda_oe   <= 1'b0;
            reg_out  <= '0;
        end else if (scl && !sda) begin
            got_start <= 1'b1;              // detect START: SDA low while SCL high
        end else if (got_start && !scl) begin
            shift[bit_idx] <= sda;          // sample data on SCL low->high edge
            if (bit_idx == ADDR_W + DATA_W) begin
                matched <= (shift[ADDR_W+DATA_W:ADDR_W+1] == my_addr);
                sda_oe  <= 1'b1;            // drive ACK
                bit_idx <= '0;
            end else begin
                bit_idx <= bit_idx + 1'b1;
            end
        end
    end

endmodule

// ---------------------------------------------------------------------------
// Testbench: write 0x5A to slave address 0x50, then read it back
// ---------------------------------------------------------------------------
module i2c_master_tb;

    localparam int CLK_HZ = 100_000_000;
    localparam int I2C_HZ = 400_000;

    logic        clk;
    logic        rst_n;
    logic        start;
    logic        rw;
    logic [6:0]  dev_addr;
    logic [7:0]  tx_data;
    logic [7:0]  rx_data;
    logic        busy;
    logic        done;
    logic        ack_err;
    wire         scl;
    wire         sda;
    logic [7:0]  slave_reg;

    // Clock generation
    initial clk = 1'b0;
    always #5 clk = ~clk;

    // Device under test
    i2c_master #(
        .CLK_HZ(CLK_HZ),
        .I2C_HZ(I2C_HZ)
    ) u_master (
        .clk      (clk),
        .rst_n    (rst_n),
        .start    (start),
        .rw       (rw),
        .dev_addr (dev_addr),
        .tx_data  (tx_data),
        .rx_data  (rx_data),
        .busy     (busy),
        .done     (done),
        .ack_err  (ack_err),
        .scl      (scl),
        .sda      (sda)
    );

    i2c_slave #(
        .ADDR_W(7),
        .DATA_W(8)
    ) u_slave (
        .clk     (clk),
        .rst_n   (rst_n),
        .my_addr (7'h50),
        .scl     (scl),
        .sda     (sda),
        .reg_out (slave_reg)
    );

    // Stimulus
    initial begin
        rst_n   = 1'b0;
        start   = 1'b0;
        rw      = 1'b0;
        dev_addr = 7'h50;
        tx_data = 8'h5A;
        #100 rst_n = 1'b1;

        // Write 0x5A to 0x50
        @(negedge clk) start = 1'b1;
        @(negedge clk) start = 1'b0;
        wait (done);

        // Read back
        @(negedge clk) begin
            rw      = 1'b1;
            start   = 1'b1;
        end
        @(negedge clk) start = 1'b0;
        wait (done);

        $display("slave_reg = 0x%02x (expect 0x5a)", slave_reg);
        if (slave_reg == 8'h5A && !ack_err) begin
            $display("I2C TEST PASSED");
        end else begin
            $display("I2C TEST FAILED (ack_err=%0d)", ack_err);
        end
        $finish;
    end

endmodule
