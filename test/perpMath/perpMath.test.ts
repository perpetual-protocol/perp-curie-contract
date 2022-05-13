import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers } from "hardhat"

describe("PerpMath test", async () => {
    const x96 = BigNumber.from(2).pow(96)
    const x10_18 = BigNumber.from(10).pow(18)
    const x10_6 = BigNumber.from(10).pow(6)
    const maxUint256 = BigNumber.from(2).pow(256).sub(1)
    const maxUint160 = BigNumber.from(2).pow(160).sub(1)
    const maxInt256 = BigNumber.from(2).pow(255).sub(1)
    const minInt256 = BigNumber.from(2).pow(255).mul(-1)

    let perpMath

    beforeEach(async () => {
        const perpMathF = await ethers.getContractFactory("TestPerpMath")
        perpMath = await perpMathF.deploy()
    })

    it("formatSqrtPriceX96ToPriceX96", async () => {
        expect(await perpMath.testFormatSqrtPriceX96ToPriceX96(maxUint160)).to.be.deep.eq(maxUint160.pow(2).div(x96))
    })

    it("formatX10_18ToX96", async () => {
        const value = maxUint256.mul(x10_18).div(x96) // per on FullMath.mulDiv() specs, max input without overflow
        expect(await perpMath.testFormatX10_18ToX96(value)).to.be.deep.eq(value.mul(x96).div(x10_18))
    })

    it("formatX96ToX10_18", async () => {
        expect(await perpMath.testFormatX96ToX10_18(maxUint256)).to.be.deep.eq(maxUint256.mul(x10_18).div(x96))
    })

    it("max", async () => {
        const a = maxInt256.sub(1)
        const b = maxInt256.sub(2)
        expect(await perpMath.testMax(a, b)).to.be.deep.eq(a)
    })

    it("min", async () => {
        const a = maxInt256.sub(1)
        const b = maxInt256.sub(2)
        expect(await perpMath.testMin(a, b)).to.be.deep.eq(b)
    })

    it("abs", async () => {
        expect(await perpMath.testAbs(minInt256.add(1))).to.be.deep.eq(minInt256.add(1).mul(-1))
    })

    it("force error, abs negative overflow", async () => {
        // TODO WIP pending PR for negative overflow
        await expect(perpMath.testAbs(minInt256)).to.be.revertedWith("PerpMath: inversion overflow")
    })

    it("divBy10_18 int", async () => {
        expect(await perpMath["testDivBy10_18(int256)"](maxInt256)).to.be.deep.eq(maxInt256.div(x10_18))
    })

    it("divBy10_18 uint", async () => {
        expect(await perpMath["testDivBy10_18(uint256)"](maxUint256)).to.be.deep.eq(maxUint256.div(x10_18))
    })

    it("mulRatio", async () => {
        // per on FullMath.mulDiv() specs, max input without overflow
        const value = BigNumber.from(2).pow(256).sub(1).div(2)
        const ratio = x10_6.mul(2)
        expect(await perpMath.testMulRatio(value, ratio)).to.be.deep.eq(value.mul(ratio).div(x10_6))
    })
})
