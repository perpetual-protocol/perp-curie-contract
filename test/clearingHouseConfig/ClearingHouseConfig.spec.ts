import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouseConfig } from "../../typechain"

describe("ClearingHouseConfig Spec", () => {
    const [wallet, alice, bob] = waffle.provider.getWallets()
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
            await expect(clearingHouseConfig.setLiquidationPenaltyRatio(2e6)).to.be.revertedWith("CHC_RO")
            await expect(clearingHouseConfig.connect(alice).setLiquidationPenaltyRatio("500000")).to.be.revertedWith(
                "SO_CNO",
            )
            await expect(clearingHouseConfig.setLiquidationPenaltyRatio("500000")) // 50%
                .to.emit(clearingHouseConfig, "LiquidationPenaltyRatioChanged")
                .withArgs(500000)
            expect(await clearingHouseConfig.getLiquidationPenaltyRatio()).eq(500000)
        })

        it("setPartialCloseRatio", async () => {
            await expect(clearingHouseConfig.setPartialCloseRatio(2e6)).to.be.revertedWith("CHC_RO")
            await expect(clearingHouseConfig.connect(alice).setPartialCloseRatio("500000")).to.be.revertedWith("SO_CNO")
            await expect(clearingHouseConfig.setPartialCloseRatio("500000")) // 50%
                .to.emit(clearingHouseConfig, "PartialCloseRatioChanged")
                .withArgs(500000)
            expect(await clearingHouseConfig.getPartialCloseRatio()).eq(500000)
        })

        it("setTwapInterval", async () => {
            await expect(clearingHouseConfig.setTwapInterval(0)).to.be.revertedWith("CHC_ITI")
            await expect(clearingHouseConfig.connect(alice).setTwapInterval(3600)).to.be.revertedWith("SO_CNO")
            await expect(clearingHouseConfig.setTwapInterval(3600))
                .to.emit(clearingHouseConfig, "TwapIntervalChanged")
                .withArgs(3600)
            expect(await clearingHouseConfig.getTwapInterval()).eq(3600)
        })

        it("setMaxMarketsPerAccount", async () => {
            await expect(clearingHouseConfig.connect(alice).setMaxMarketsPerAccount(10)).to.be.revertedWith("SO_CNO")
            await expect(clearingHouseConfig.setMaxMarketsPerAccount(10))
                .to.emit(clearingHouseConfig, "MaxMarketsPerAccountChanged")
                .withArgs(10)
            expect(await clearingHouseConfig.getMaxMarketsPerAccount()).eq(10)
        })

        it("setSettlementTokenBalanceCap", async () => {
            await expect(clearingHouseConfig.connect(alice).setSettlementTokenBalanceCap(100)).to.be.revertedWith(
                "SO_CNO",
            )
            await expect(clearingHouseConfig.setSettlementTokenBalanceCap(100))
                .to.emit(clearingHouseConfig, "SettlementTokenBalanceCapChanged")
                .withArgs(100)
            expect(await clearingHouseConfig.getSettlementTokenBalanceCap()).eq(100)
        })

        it("setBackstopLiquidityProvider", async () => {
            expect(await clearingHouseConfig.isBackstopLiquidityProvider(bob.address)).eq(false)
            await expect(
                clearingHouseConfig.connect(alice).setBackstopLiquidityProvider(bob.address, true),
            ).to.be.revertedWith("SO_CNO")

            await expect(clearingHouseConfig.setBackstopLiquidityProvider(bob.address, true))
                .to.emit(clearingHouseConfig, "BackstopLiquidityProviderChanged")
                .withArgs(bob.address, true)
            expect(await clearingHouseConfig.isBackstopLiquidityProvider(bob.address)).eq(true)
        })

        it("fore error, partialCloseRatio should not be 0", async () => {
            await expect(clearingHouseConfig.setPartialCloseRatio(0)).to.be.revertedWith("CHC_IPCR")
        })
    })
})
