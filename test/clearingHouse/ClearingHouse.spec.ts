import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse } from "../../typechain"
import { mockedClearingHouseFixture } from "./fixtures"

describe("ClearingHouse Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"

    let clearingHouse: ClearingHouse
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract
    let exchange: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(mockedClearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        baseToken = _clearingHouseFixture.mockedBaseToken
        quoteToken = _clearingHouseFixture.mockedQuoteToken
        uniV3Factory = _clearingHouseFixture.mockedUniV3Factory
        exchange = _clearingHouseFixture.mockedExchange

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
    })

    describe("onlyOwner setters", () => {
        it("setLiquidationPenaltyRatio", async () => {
            await expect(clearingHouse.setLiquidationPenaltyRatio(2e6)).to.be.revertedWith("CH_RO")
            await expect(clearingHouse.setLiquidationPenaltyRatio("5000"))
                .to.emit(clearingHouse, "LiquidationPenaltyRatioChanged")
                .withArgs(5000)
            expect(await clearingHouse.liquidationPenaltyRatio()).eq(5000)
        })

        it("setPartialCloseRatio", async () => {
            await expect(clearingHouse.setPartialCloseRatio(2e6)).to.be.revertedWith("CH_RO")
            await expect(clearingHouse.setPartialCloseRatio("5000"))
                .to.emit(clearingHouse, "PartialCloseRatioChanged")
                .withArgs(5000)
            expect(await clearingHouse.partialCloseRatio()).eq(5000)
        })

        it("setTwapInterval", async () => {
            await expect(clearingHouse.setTwapInterval(0)).to.be.revertedWith("CH_ITI")
            await expect(clearingHouse.setTwapInterval(3600))
                .to.emit(clearingHouse, "TwapIntervalChanged")
                .withArgs(3600)
            expect(await clearingHouse.twapInterval()).eq(3600)
        })
    })

    describe("# getRequiredCollateral", () => {})
})
