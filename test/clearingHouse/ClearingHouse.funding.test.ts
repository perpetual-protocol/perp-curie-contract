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
            await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

            // price at 50400 == 154.4310961
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50200,
                upperTick: 50400,
            })

            // bob short
            await collateral.mint(bob.address, parseEther("1000"))
            await collateral.connect(bob).approve(clearingHouse.address, parseEther("1000"))
            await clearingHouse.connect(bob).deposit(parseEther("1000"))
            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("2"))

            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
            })

            // mark price should be 153.9623330511 (tick ~= 50369)

            // forward 3600 secs to get 1hr twap in UniV3 pool
            await forward(3600)

            // TODO somehow mark TWAP becomes 153.9531248192 which is not exactly the same as the mark price immediately after bob swap
            //  check why is that the case
        })

        it("get correct number for maker before any update funding", async () => {
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
        })

        it("get correct number for maker in positive funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.1
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("99999999999999998")
            // TODO for now, position size is 0.099 for funding calculation. We should take fee into considerations in the future
            // funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "12375003379192555",
            )
            //   position size = -0.1
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.1"))
            //   funding payment = -0.1 * (153.9531248192 - 150.953124) / 24 = 0.012500000341
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(
                "-12500003413325814",
            )
        })

        it("get correct number for maker in negative funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("156.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.1
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("99999999999999998")
            // TODO for now, position size is 0.099 for funding calculation. We should take fee into considerations in the future
            // funding payment = 0.099 * (153.9531248192 - 156.953124) / 24 = -0.01237499662
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "-12374996620807443",
            )
            //   position size = -0.1
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.1"))
            //   funding payment = -0.1 * (153.9531248192 - 156.953124) / 24 = 0.01249999659
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq("12499996586674185")
        })

        it("get correct number for maker in multiple orders and funding rates", async () => {
            // alice to add her second open order
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            // first update funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // bob short
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })

            // afterwards, mark price = 149.403346446539268519

            // forward another 3600 secs
            await forward(3600)

            // second update funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("152.403346", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.1 + 1 ~= 1.1
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("1099999999999999996")
            // TODO for now, position size is 0.099, 1.089, respectively for funding calculation. We should take fee into considerations in the future
            // funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            // funding payment = 1.089 * (149.403346446539268519 - 152.403346) / 24 = -0.1361249797
            // 0.01237500338 + (-0.1361249797) = -0.1237499763
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "-123749976359088135",
            )
        })

        it("get correct number when there is no positions", async () => {})

        it("get correct number when base token does not exist", async () => {})

        it("get correct number when trader does not exist", async () => {})
    })
})
