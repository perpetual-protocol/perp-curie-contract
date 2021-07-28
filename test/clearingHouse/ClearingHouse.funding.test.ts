import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { BaseToken } from "../../typechain/BaseToken"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.funding", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        await clearingHouse.addPool(baseToken.address, "10000")

        // alice add long limit order
        await collateral.mint(alice.address, parseEther("10000"))
        await deposit(alice, vault, 10000, collateral)

        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

        // price at 50400 == 154.4310961
        await pool.initialize(encodePriceSqrt("154.4310961", "1"))

        // alice:
        //   base.liquidity = 0
        //   quote.liquidity = 100
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("0"),
            quote: parseEther("100"),
            lowerTick: 50200,
            upperTick: 50400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // bob short
        await collateral.mint(bob.address, parseEther("1000"))
        await deposit(bob, vault, 1000, collateral)

        await clearingHouse.connect(bob).mint(baseToken.address, parseEther("2"))

        await clearingHouse.connect(bob).swap({
            // sell base
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            amount: parseEther("0.099"),
            sqrtPriceLimitX96: 0,
        })

        // alice:
        //   base.liquidity = 0
        //   quote.liquidity = 100
        // bob:
        //   base.available = 2 - 0.099 = 1.901
        //   base.debt = 2
        //   quote.available = 15.1128025359
        //   quote.debt = 0

        // mark price should be 153.9623330511 (tick ~= 50369)

        // forward 3600 secs to get 1hr twap in UniV3 pool
        await forward(3600)

        // TODO somehow mark TWAP becomes 153.9531248192 which is not exactly the same as the mark price immediately after bob swap
        //  check why is that the case
    })

    async function forward(seconds: number) {
        const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
        await waffle.provider.send("evm_setNextBlockTimestamp", [lastTimestamp + seconds])
        await waffle.provider.send("evm_mine", [])
    }

    describe("# getPendingFundingPayment", () => {
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
            // position size = 0.099 (bob swaps in CH) -> 0.099 / 0.99 (in Uni; before swap fee charged) -> 0.1 * 0.99 (in Uni; fee charged)
            // 0.099 / 0.99 * 0.99 = 0.099; has one wei of imprecision
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("98999999999999999")
            // funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "12375003379192555",
            )
            // position size = -0.099
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.099"))
            // funding payment = -0.099 * (153.9531248192 - 150.953124) / 24 = -0.01237500338
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(
                "-12375003379192555",
            )
        })

        it("get correct number for maker in negative funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("156.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.099 (bob swaps in CH) -> 0.099 / 0.99 (in Uni; before swap fee charged) -> 0.1 * 0.99 (in Uni; fee charged)
            // 0.099 / 0.99 * 0.99 = 0.099; has one wei of imprecision
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("98999999999999999")
            // funding payment = 0.099 * (153.9531248192 - 156.953124) / 24 = -0.01237499662
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "-12374996620807443",
            )
            // position size = -0.099
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.099"))
            // funding payment = -0.099 * (153.9531248192 - 156.953124) / 24 = 0.01237499662
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq("12374996620807443")
        })

        it("get correct number for maker in multiple orders and funding rates", async () => {
            // alice to add her second open order
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
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
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.99"),
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
            // position size (0.099 + 0.99) / 0.99 * 0.99 = 1.089; has one wei of imprecision
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("1088999999999999997")
            // funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            // funding payment = 1.089 * (149.403346446539268519 - 152.403346) / 24 = -0.1361249797
            // 0.01237500338 + (-0.1361249797) = -0.1237499763
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "-123749976359088135",
            )
        })

        it("get correct number when there is no positions", async () => {
            // carol mint token but not trading (zero positions)
            await collateral.mint(carol.address, parseEther("10000"))
            await deposit(carol, vault, 10000, collateral)

            await clearingHouse.connect(carol).mint(baseToken.address, parseEther("10"))

            // update funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("152.403346", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // carol
            // position size = 0
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(0)
            // funding payment = 0 * (154.4310961 - 152.403346) / 24 = 0
            expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).eq(0)
        })

        it("get correct number when base token does not exist", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            expect(await clearingHouse.getPendingFundingPayment(alice.address, quoteToken.address)).eq(0)
        })

        it("get correct number when trader does not exist", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("152.403346", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // carol
            // position size = 0
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(0)
            // funding payment = 0 * (154.4310961 - 152.403346) / 24 = 0
            expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).eq(0)
        })
    })

    describe("# settleFunding", () => {
        let prevCostBasis
        beforeEach(async () => {
            // so bob has some liquidity to remove for a future test
            await clearingHouse.connect(bob).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("0"),
                lowerTick: 50400,
                upperTick: 50600,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // bob
            //   base.available = 1.901 - 1 = 0.901
            //   base.liquidity = 1
            //   base.debt = 2
            //   quote.available = 15.1128025359
            //   quote.debt = 0

            // bob hold a short position 0.099
            // (153.9531248192 - 150.953124) / 24 = 0.1250000341
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)
            prevCostBasis = await clearingHouse.getCostBasis(bob.address)
        })

        it("settle funding directly", async () => {
            await expect(clearingHouse.settleFunding(bob.address, baseToken.address))
                .to.emit(clearingHouse, "FundingSettled")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    1, // one funding history item
                    "-12375003379192556", // 0.1250000341 * 0.099 = 0.01237500338
                )

            expect((await clearingHouse.getCostBasis(bob.address)).sub(prevCostBasis)).eq("12375003379192556")
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)

            // should not settle again
            prevCostBasis = await clearingHouse.getCostBasis(bob.address)
            await expect(clearingHouse.settleFunding(bob.address, baseToken.address)).not.emit(
                clearingHouse,
                "FundingSettled",
            )
            expect(await clearingHouse.getCostBasis(bob.address)).eq(prevCostBasis)
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)
        })

        it("settle funding in mint()", async () => {
            await expect(clearingHouse.connect(bob).mint(baseToken.address, parseEther("1")))
                .to.emit(clearingHouse, "FundingSettled")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    1, // one funding history item
                    "-12375003379192556", // 0.1250000341 * 0.099 = 0.01237500338
                )
            expect((await clearingHouse.getCostBasis(bob.address)).sub(prevCostBasis)).eq("12375003379192556")
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)
        })

        it("settle funding in burn()", async () => {
            await expect(clearingHouse.connect(bob).burn(baseToken.address, parseEther("0.1")))
                .to.emit(clearingHouse, "FundingSettled")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    1, // one funding history item
                    "-12375003379192556", // 0.1250000341 * 0.099 = 0.01237500338
                )
            expect((await clearingHouse.getCostBasis(bob.address)).sub(prevCostBasis)).eq("12375003379192556")
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)
        })

        it("settle funding in swap()", async () => {
            await expect(
                clearingHouse.connect(bob).swap({
                    // sell base
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: parseEther("1"), // swap to exactly 1 quote token
                    sqrtPriceLimitX96: 0,
                }),
            )
                .to.emit(clearingHouse, "FundingSettled")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    1, // one funding history item
                    "-12375003379192556", // 0.1250000341 * 0.099 = 0.01237500338
                )
                .to.emit(clearingHouse, "Swapped")
                .withArgs(
                    bob.address, // trader
                    baseToken.address, // baseToken
                    "-6561362585509647", // exchangedPositionSize
                    parseEther("1.010101010101010102"), // costBasis
                    "10101010101010102", // fee: 1.010101010101010102 * 0.01 = 0.010101010101010102
                    "-12375003379192556", // fundingPayment
                    parseEther("0"), // badDebt
                )

            // 1 + 0.012375003379192556 = 1.012375003379192556
            expect((await clearingHouse.getCostBasis(bob.address)).sub(prevCostBasis)).eq("1012375003379192556")
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)
        })

        it("settle funding in addLiquidity()", async () => {
            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.1"),
                    quote: parseEther("0"),
                    lowerTick: 50400,
                    upperTick: 50600,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "FundingSettled")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    1, // one funding history item
                    "-12375003379192556", // 0.1250000341 * 0.099 = 0.01237500338
                )
            expect((await clearingHouse.getCostBasis(bob.address)).sub(prevCostBasis)).eq("12375003379192556")
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)
        })

        it("settle funding in removeLiquidity()", async () => {
            await expect(
                clearingHouse.connect(bob).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50400,
                    upperTick: 50600,
                    liquidity: (
                        await clearingHouse.getOpenOrder(bob.address, baseToken.address, 50400, 50600)
                    ).liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "FundingSettled")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    1, // one funding history item
                    "-12375003379192556", // 0.1250000341 * 0.099 = 0.01237500338
                )
            expect((await clearingHouse.getCostBasis(bob.address)).sub(prevCostBasis)).eq("12375003379192556")
            expect(await clearingHouse.getNextFundingIndex(bob.address, baseToken.address)).eq(1)
        })

        it("force error, settle quote token", async () => {
            await expect(clearingHouse.settleFunding(bob.address, quoteToken.address)).to.be.revertedWith("CH_QT")
        })

        it("force error, not enough quote token available", async () => {
            // carol long
            await collateral.mint(carol.address, parseEther("1000"))
            await deposit(carol, vault, 1000, collateral)

            await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("100"))
            await clearingHouse.connect(carol).swap({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // bob
            //   base.available = 1.901 - 1 = 0.901
            //   base.liquidity = 1
            //   base.debt = 2
            //   quote.available = 15.1128025359
            //   quote.debt = 0
            //
            // carol
            //   base.available = 0.638303511
            //   base.debt = 0
            //   quote.available = 0
            //   quote.debt = 100

            // current price = 156.0922973283
            // current tick = 50507

            await forward(3600)

            // carol hold a long position 0.638303511
            // (156.0922973283 - 150.953124) / 24 = 0.1250000341
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // carol needs to pay 0.638303511 * 0.1250000341 = 0.07978796064 quote for funding but has 0 available
            await expect(clearingHouse.settleFunding(carol.address, baseToken.address)).to.revertedWith("TBD")
        })
    })
})
