import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { BaseToken } from "../../typechain/BaseToken"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.funding", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        await clearingHouse.addPool(baseToken.address, "10000")
    })

    describe("# getPendingFundingPayment", () => {
        beforeEach(async () => {
            // alice add long limit order
            await collateral.mint(alice.address, parseEther("10"))
            await collateral.connect(alice).approve(clearingHouse.address, parseEther("10"))
            await clearingHouse.connect(alice).deposit(parseEther("10"))
            await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("10"))

            await pool.initialize(encodePriceSqrt("154.4310961", "1"))

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("10"),
                lowerTick: 50200,
                upperTick: 50400,
            })

            // bob short
            await collateral.mint(bob.address, parseEther("100"))
            await collateral.connect(bob).approve(clearingHouse.address, parseEther("100"))
            await clearingHouse.connect(bob).deposit(parseEther("100"))
            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("1"))

            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.01"),
                sqrtPriceLimitX96: 0,
            })

            // TODO test
            const aliceTokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            const bobTokenInfo = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
            console.log(
                `alice available: ${aliceTokenInfo.available.toString()}, debt: ${aliceTokenInfo.debt.toString()}`,
            )
            console.log(`bob available: ${bobTokenInfo.available.toString()}, debt: ${bobTokenInfo.debt.toString()}`)
        })

        it("get correct number for maker before any update funding", async () => {
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
        })

        it("get correct number for maker in positive funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseEther("150.4310961"), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            //   position size = 0.01
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq()
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
        })

        it("get correct number for maker in negative funding rate", async () => {})

        it("get correct number for maker in multiple orders and funding rates", async () => {})

        it("get correct number when there is no positions", async () => {})

        it("get correct number when base token does not exist", async () => {})

        it("get correct number when trader does not exist", async () => {})
    })
})
