import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition", () => {
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

        // mint
        collateral.mint(admin.address, toWei(10000))

        // prepare collateral for alice
        const amount = toWei(1000, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
        await clearingHouse.connect(alice).deposit(amount)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
    })

    describe("invalid input", () => {
        it("force error due to invalid market")
        it("force error due to zero amount")
        it("force error due to slippage protection")
        it("force error due to not enough liquidity")
        it("force error due to not enough collateral")
    })

    describe("taker opens long from scratch", () => {
        it("settle funding payment")
        it("mint missing amount of vUSD for swapping")
        it("does not mint anything if the vUSD is sufficient")
    })

    describe("taker opens short from scratch", () => {
        it("settle funding payment")
        it("mint missing amount of vETH for swapping")
        it("will not mint anything if vETH is sufficient")
    })

    describe("opening long first", () => {
        it("increase position")
        it("reduce position")
        it("close position")
        it("open larger reverse position")
    })

    describe("opening short first", () => {
        it("increase position")
        it("reduce position")
        it("close position")
        it("open larger reverse position")
    })

    describe("maker has order out of price range", () => {
        it("will not affect her range order")
    })

    describe("maker has order within price range", () => {
        it("will not affect her range order")
        it("force error if she is going to liquidate herself")
    })
})
