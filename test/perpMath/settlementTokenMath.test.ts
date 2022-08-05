import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers } from "hardhat"
import { TestSettlementTokenMath } from "../../typechain"

describe("SettlementTokenMath test", async () => {
    const maxUint256 = BigNumber.from(2).pow(256).sub(1)
    const maxInt256 = BigNumber.from(2).pow(255).sub(1)
    const minInt256 = BigNumber.from(2).pow(255).mul(-1)

    let settlementTokenMath: TestSettlementTokenMath

    beforeEach(async () => {
        const settlementTokenMathF = await ethers.getContractFactory("TestSettlementTokenMath")
        settlementTokenMath = (await settlementTokenMathF.deploy()) as TestSettlementTokenMath
    })

    describe("lte", async () => {
        it("compare with uint256", async () => {
            // less than
            expect(
                await settlementTokenMath["testLte(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1001"),
                    8,
                ),
            ).to.be.eq(true)

            // greater than
            expect(
                await settlementTokenMath["testLte(uint256,uint256,uint8)"](
                    parseUnits("1001", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(false)

            // equal to
            expect(
                await settlementTokenMath["testLte(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(true)
        })

        it("compare with int256", async () => {
            // less than
            expect(
                await settlementTokenMath["testLte(int256,int256,uint8)"](
                    parseUnits("-1001", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(true)

            // greater than
            expect(
                await settlementTokenMath["testLte(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1001"),
                    8,
                ),
            ).to.be.eq(false)

            // equal to
            expect(
                await settlementTokenMath["testLte(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(true)
        })
    })

    describe("lt", async () => {
        it("compare with uint256", async () => {
            // less than
            expect(
                await settlementTokenMath["testLt(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1001"),
                    8,
                ),
            ).to.be.eq(true)

            // greater than
            expect(
                await settlementTokenMath["testLt(uint256,uint256,uint8)"](
                    parseUnits("1001", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(false)

            // equal to
            expect(
                await settlementTokenMath["testLt(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(false)
        })

        it("compare with int256", async () => {
            // less than
            expect(
                await settlementTokenMath["testLt(int256,int256,uint8)"](
                    parseUnits("-1001", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(true)

            // greater than
            expect(
                await settlementTokenMath["testLt(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1001"),
                    8,
                ),
            ).to.be.eq(false)

            // equal to
            expect(
                await settlementTokenMath["testLt(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(false)
        })
    })

    describe("gte", async () => {
        it("compare with uint256", async () => {
            // less than
            expect(
                await settlementTokenMath["testGte(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1001"),
                    8,
                ),
            ).to.be.eq(false)

            // greater than
            expect(
                await settlementTokenMath["testGte(uint256,uint256,uint8)"](
                    parseUnits("1001", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(true)

            // equal to
            expect(
                await settlementTokenMath["testGte(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(true)
        })

        it("compare with int256", async () => {
            // less than
            expect(
                await settlementTokenMath["testGte(int256,int256,uint8)"](
                    parseUnits("-1001", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(false)

            // greater than
            expect(
                await settlementTokenMath["testGte(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1001"),
                    8,
                ),
            ).to.be.eq(true)

            // equal to
            expect(
                await settlementTokenMath["testGte(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(true)
        })
    })

    describe("gt", async () => {
        it("compare with uint256", async () => {
            // less than
            expect(
                await settlementTokenMath["testGt(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1001"),
                    8,
                ),
            ).to.be.eq(false)

            // greater than
            expect(
                await settlementTokenMath["testGt(uint256,uint256,uint8)"](
                    parseUnits("1001", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(true)

            // equal to
            expect(
                await settlementTokenMath["testGt(uint256,uint256,uint8)"](
                    parseUnits("1000", 8),
                    parseEther("1000"),
                    8,
                ),
            ).to.be.eq(false)
        })

        it("compare with int256", async () => {
            // less than
            expect(
                await settlementTokenMath["testGt(int256,int256,uint8)"](
                    parseUnits("-1001", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(false)

            // greater than
            expect(
                await settlementTokenMath["testGt(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1001"),
                    8,
                ),
            ).to.be.eq(true)

            // equal to
            expect(
                await settlementTokenMath["testGt(int256,int256,uint8)"](
                    parseUnits("-1000", 8),
                    parseEther("-1000"),
                    8,
                ),
            ).to.be.eq(false)
        })
    })

    describe("parseSettlementToken", async () => {
        it("parse uint256 from 8 decimals", async () => {
            expect(
                await settlementTokenMath["testParseSettlementToken(uint256,uint8)"](parseUnits("1000", 8), 8),
            ).to.be.eq(parseEther("1000"))
        })

        it("parse int256 from 8 decimals", async () => {
            expect(
                await settlementTokenMath["testParseSettlementToken(int256,uint8)"](parseUnits("-1000", 8), 8),
            ).to.be.eq(parseEther("-1000"))
        })
    })

    describe("formatSettlementToken", async () => {
        it("format uint256 to 8 decimals", async () => {
            expect(
                await settlementTokenMath["testFormatSettlementToken(uint256,uint8)"](parseEther("1000"), 8),
            ).to.be.eq(parseUnits("1000", 8))
        })

        it("format int256 to 8 decimals", async () => {
            expect(
                await settlementTokenMath["testFormatSettlementToken(int256,uint8)"](parseEther("-1000"), 8),
            ).to.be.eq(parseUnits("-1000", 8))
        })

        it("format with rounding down on positive number", async () => {
            expect(
                await settlementTokenMath["testFormatSettlementToken(int256,uint8)"]("100123456789123456789", 8),
            ).to.be.eq("10012345678")
        })

        it("format with rounding down on negative number", async () => {
            expect(
                await settlementTokenMath["testFormatSettlementToken(int256,uint8)"]("-100123456789123456789", 8),
            ).to.be.eq("-10012345679")
        })
    })

    describe("convertTokenDecimals", async () => {
        it("convert uint256 from 18 decimals to 8 decimals", async () => {
            expect(
                await settlementTokenMath["testConvertTokenDecimals(uint256,uint8,uint8)"](parseEther("1000"), 18, 8),
            ).to.be.eq(parseUnits("1000", 8))
        })

        it("convert uint256 from 8 decimals to 18 decimals", async () => {
            expect(
                await settlementTokenMath["testConvertTokenDecimals(uint256,uint8,uint8)"](
                    parseUnits("1000", 8),
                    8,
                    18,
                ),
            ).to.be.eq(parseEther("1000"))
        })

        it("convert int256 from 18 decimals to 8 decimals", async () => {
            expect(
                await settlementTokenMath["testConvertTokenDecimals(int256,uint8,uint8)"](parseEther("-1000"), 18, 8),
            ).to.be.eq(parseUnits("-1000", 8))
        })

        it("convert int256 from 8 decimals to 18 decimals", async () => {
            expect(
                await settlementTokenMath["testConvertTokenDecimals(int256,uint8,uint8)"](
                    parseUnits("-1000", 8),
                    8,
                    18,
                ),
            ).to.be.eq(parseEther("-1000"))
        })

        it("convert with rounding down on positive number from 18 to 8 decimals", async () => {
            expect(
                await settlementTokenMath["testConvertTokenDecimals(int256,uint8,uint8)"](
                    "100123456789123456789",
                    18,
                    8,
                ),
            ).to.be.eq("10012345678")
        })

        it("convert with rounding down on negative number from 18 to 8 decimals", async () => {
            expect(
                await settlementTokenMath["testConvertTokenDecimals(int256,uint8,uint8)"](
                    "-100123456789123456789",
                    18,
                    8,
                ),
            ).to.be.eq("-10012345679")
        })
    })
})
