import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouseConfig } from "../../typechain"

describe("ClearingHouseConfig Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let clearingHouseConfig: ClearingHouseConfig

    async function chConfigFixture(): Promise<ClearingHouseConfig> {
        const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
        const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
        await clearingHouseConfig.initialize()
        return clearingHouseConfig
    }

    beforeEach(async () => {
        clearingHouseConfig = await loadFixture(chConfigFixture)
    })

    describe("onlyOwner setters", () => {
        it("setLiquidationPenaltyRatio", async () => {
            await expect(clearingHouseConfig.setLiquidationPenaltyRatio(2e6)).to.be.revertedWith("CH_RO")
            await expect(clearingHouseConfig.setLiquidationPenaltyRatio("500000")) // 50%
                .to.emit(clearingHouseConfig, "LiquidationPenaltyRatioChanged")
                .withArgs(500000)
            expect(await clearingHouseConfig.liquidationPenaltyRatio()).eq(500000)
        })

        it("setPartialCloseRatio", async () => {
            await expect(clearingHouseConfig.setPartialCloseRatio(2e6)).to.be.revertedWith("CH_RO")
            await expect(clearingHouseConfig.setPartialCloseRatio("500000")) // 50%
                .to.emit(clearingHouseConfig, "PartialCloseRatioChanged")
                .withArgs(500000)
            expect(await clearingHouseConfig.partialCloseRatio()).eq(500000)
        })

        it("setTwapInterval", async () => {
            await expect(clearingHouseConfig.setTwapInterval(0)).to.be.revertedWith("CH_ITI")
            await expect(clearingHouseConfig.setTwapInterval(3600))
                .to.emit(clearingHouseConfig, "TwapIntervalChanged")
                .withArgs(3600)
            expect(await clearingHouseConfig.twapInterval()).eq(3600)
        })
    })
})
