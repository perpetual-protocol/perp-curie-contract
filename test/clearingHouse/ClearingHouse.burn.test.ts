import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.burn", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool

        await clearingHouse.addPool(baseToken.address, "10000")
    })

    describe("burn when debt = 10", () => {
        beforeEach(async () => {
            await collateral.mint(alice.address, toWei(10))
            await collateral.connect(alice).approve(clearingHouse.address, toWei(10))
            await clearingHouse.connect(alice).deposit(toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))
            await clearingHouse.connect(alice).mint(quoteToken.address, toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(9))
        })

        it("# burn quote 10 when debt = 10, available = 10", async () => {
            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(10), // available
                toWei(10), // debt
            ])

            await expect(clearingHouse.connect(alice).burn(quoteToken.address, toWei(10)))
                .to.emit(clearingHouse, "Burned")
                .withArgs(quoteToken.address, toWei(10))

            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(0), // available
                toWei(0), // debt
            ])

            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))
        })

        it("# burn quote 10 when debt = 10, available = 20", () => {})

        it("# burn quote 10 when debt = 10, available = 5", () => {})

        it("# force fail when the user has no vTokens", async () => {
            await expect(clearingHouse.connect(alice).burn(EMPTY_ADDRESS, 10)).to.be.revertedWith("CH_TNF")

            await expect(clearingHouse.connect(alice).burn(quoteToken.address, 0)).to.be.revertedWith("CH_IA")
        })
    })
})
