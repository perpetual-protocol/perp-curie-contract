import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
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

    async function forward(seconds: number) {
        const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
        await waffle.provider.send("evm_setNextBlockTimestamp", [lastTimestamp + seconds])
        await waffle.provider.send("evm_mine", [])
    }

    describe("# getPendingFundingPayment", () => {
        beforeEach(async () => {
            // alice add long limit order
            await collateral.mint(alice.address, parseEther("10000"))
            await collateral.connect(alice).approve(clearingHouse.address, parseEther("10000"))
            await clearingHouse.connect(alice).deposit(parseEther("10000"))
            await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
            // await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

            // price at 50400 == 154.4310961
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50200,
                upperTick: 50400,
            })

            console.log(`sqrt mark price: ${await clearingHouse.getSqrtMarkPriceX96(baseToken.address)}`)
            console.log(
                `alice position size: ${(
                    await clearingHouse.getPositionSize(alice.address, baseToken.address)
                ).toString()}`,
            )

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
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
            })

            // mark price should be 153.9623330511

            // forward 3600 secs to get 1hr twap in UniV3 pool
            await forward(3600)

            // TODO somehow mark TWAP becomes 153.9531248192 which is not exactly the same as the mark price immediately after bob swap
            //  check why is that the case

            // TODO test
            console.log(
                `getSqrtMarkPriceX96: ${(await clearingHouse.getSqrtMarkPriceX96(baseToken.address)).toString()}`,
            )
            const aliceBaseTokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            const aliceQuoteTokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            const bobBaseTokenInfo = await clearingHouse.getTokenInfo(bob.address, baseToken.address)
            const bobQuoteTokenInfo = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
            console.log(`sqrt mark price: ${await clearingHouse.getSqrtMarkPriceX96(baseToken.address)}`)
            console.log(
                `alice base available: ${aliceBaseTokenInfo.available.toString()}, debt: ${aliceBaseTokenInfo.debt.toString()}, position size: ${(
                    await clearingHouse.getPositionSize(alice.address, baseToken.address)
                ).toString()}`,
            )
            console.log(
                `alice quote available: ${aliceQuoteTokenInfo.available.toString()}, debt: ${aliceQuoteTokenInfo.debt.toString()}`,
            )
            const aliceOrderIds = await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)
            console.log(`alice order IDs: ${aliceOrderIds}, length: ${aliceOrderIds.length}`)
            const aliceOpenOrder = await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            console.log(`alice open order liquidity: ${aliceOpenOrder.liquidity.toString()}`)
            console.log(
                `bob base available: ${bobBaseTokenInfo.available.toString()}, debt: ${bobBaseTokenInfo.debt.toString()}, position size: ${(
                    await clearingHouse.getPositionSize(bob.address, baseToken.address)
                ).toString()}`,
            )
            console.log(
                `bob quote available: ${bobQuoteTokenInfo.available.toString()}, debt: ${bobQuoteTokenInfo.debt.toString()}`,
            )
            console.log("========================")
        })

        it("get correct number for maker before any update funding", async () => {
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
        })

        it.only("get correct number for maker in positive funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.099
            // TODO position size should be 0.1 after we taking fee into consideration
            //   funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "12375003379192555",
            )
            //   position size = -0.1
            //   funding payment = 0.1 * (153.9531248192 - 150.953124) / 24 = 0.012500000341
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(
                "-12500003413325814",
            )
        })

        it("get correct number for maker in negative funding rate", async () => {})

        it("get correct number for maker in multiple orders and funding rates", async () => {})

        it("get correct number when there is no positions", async () => {})

        it("get correct number when base token does not exist", async () => {})

        it("get correct number when trader does not exist", async () => {})
    })
})
