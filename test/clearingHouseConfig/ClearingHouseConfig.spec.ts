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
    })
})
