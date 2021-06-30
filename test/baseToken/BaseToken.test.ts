import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { BaseToken } from "../../typechain"
import { toWei } from "../helper/number"
import { baseTokenFixture } from "./fixtures"

// TODO: should also test ChainlinkPriceFeed
describe("BaseToken", async () => {
    const [admin] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let baseToken: BaseToken
    let mockedAggregator: MockContract
    let currentTimestamp: number
    let roundData: any[]

    describe("twap", () => {
        beforeEach(async () => {
            const _fixture = await loadFixture(baseTokenFixture)
            baseToken = _fixture.baseToken
            mockedAggregator = _fixture.mockedAggregator

            // `base` = now - _interval
            // aggregator's answer
            // timestamp(base + 0)  : 400
            // timestamp(base + 15) : 405
            // timestamp(base + 30) : 410
            // now = base + 45
            //
            //  --+------+-----+-----+-----+-----+-----+
            //          base                          now
            const latestTimestamp = (await waffle.provider.getBlock("latest")).timestamp
            currentTimestamp = latestTimestamp
            roundData = [
                // [roundId, answer, startedAt, updatedAt, answeredInRound]
            ]

            currentTimestamp += 0
            roundData.push([0, toWei(400, 6), currentTimestamp, currentTimestamp, 0])

            currentTimestamp += 15
            roundData.push([1, toWei(405, 6), currentTimestamp, currentTimestamp, 1])

            currentTimestamp += 15
            roundData.push([2, toWei(410, 6), currentTimestamp, currentTimestamp, 2])

            mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
                return roundData[roundData.length - 1]
            })

            mockedAggregator.smocked.getRoundData.will.return.with((round: BigNumber) => {
                return roundData[round.toNumber()]
            })

            currentTimestamp += 15
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTimestamp])
            await ethers.provider.send("evm_mine", [])
        })

        it("twap price", async () => {
            const price = await baseToken.getIndexTwapPrice(45)
            expect(price).to.eq(toWei(405))
        })

        it("asking interval more than aggregator has", async () => {
            const price = await baseToken.getIndexTwapPrice(46)
            expect(price).to.eq(toWei(405))
        })

        it("asking interval less than aggregator has", async () => {
            const price = await baseToken.getIndexTwapPrice(44)
            expect(price).to.eq("405113636000000000000")
        })

        it("given variant price period", async () => {
            roundData.push([4, toWei(420, 6), currentTimestamp + 30, currentTimestamp + 30, 4])
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTimestamp + 50])
            await ethers.provider.send("evm_mine", [])

            // twap price should be ((400 * 15) + (405 * 15) + (410 * 45) + (420 * 20)) / 95 = 409.736
            const price = await baseToken.getIndexTwapPrice(95)
            expect(price).to.eq("409736842000000000000")
        })

        // it("latest price update time is earlier than the request, return the latest price", async () => {
        //     const currentTime = await priceFeed.mock_getCurrentTimestamp()
        //     await priceFeed.mock_setBlockTimestamp(currentTime.addn(100))

        //     // latest update time is base + 30, but now is base + 145 and asking for (now - 45)
        //     // should return the latest price directly
        //     const price = await priceFeed.getTwapPrice(stringToBytes32("ETH"), 45)
        //     expect(price).to.eq(toFullDigit(410))
        // })

        // it("if current price < 0, ignore the current price", async () => {
        //     await chainlinkMock1.mockAddAnswer(3, toFullDigit(-10, CHAINLINK_DECIMAL), 250, 250, 3)
        //     const price = await priceFeed.getTwapPrice(stringToBytes32("ETH"), 45)
        //     expect(price).to.eq(toFullDigit(405))
        // })

        // it("if there is a negative price in the middle, ignore that price", async () => {
        //     const currentTime = await priceFeed.mock_getCurrentTimestamp()
        //     await chainlinkMock1.mockAddAnswer(
        //         3,
        //         toFullDigit(-100, CHAINLINK_DECIMAL),
        //         currentTime.addn(20),
        //         currentTime.addn(20),
        //         3,
        //     )
        //     await chainlinkMock1.mockAddAnswer(
        //         4,
        //         toFullDigit(420, CHAINLINK_DECIMAL),
        //         currentTime.addn(30),
        //         currentTime.addn(30),
        //         4,
        //     )
        //     await priceFeed.mock_setBlockTimestamp(currentTime.addn(50))

        //     // twap price should be (400 * 15) + (405 * 15) + (410 * 45) + (420 * 20) / 95 = 409.74
        //     const price = await priceFeed.getTwapPrice(stringToBytes32("ETH"), 95)
        //     expect(price).to.eq("409736842100000000000")
        // })

        // it("force error, interval is zero", async () => {
        //     await expectRevert(priceFeed.getTwapPrice(stringToBytes32("ETH"), 0), "interval can't be 0")
        // })
    })
})
