// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../ClearingHouse.sol";
import "./TestAccountBalance.sol";
import "./TestExchange.sol";

contract TestClearingHouse is ClearingHouse {
    using PerpSafeCast for uint256;
    using SignedSafeMathUpgradeable for int256;

    uint256 private _testBlockTimestamp;

    function __TestClearingHouse_init(
        address configArg,
        address vaultArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        address exchangeArg,
        address accountBalanceArg
    ) external initializer {
        ClearingHouse.initialize(configArg, vaultArg, quoteTokenArg, uniV3FactoryArg, exchangeArg, accountBalanceArg);
        _testBlockTimestamp = block.timestamp;
    }

    function setBlockTimestamp(uint256 blockTimestamp) external {
        TestAccountBalance(_accountBalance).setBlockTimestamp(blockTimestamp);
        TestExchange(_exchange).setBlockTimestamp(blockTimestamp);
        _testBlockTimestamp = blockTimestamp;
    }

    function getBlockTimestamp() external view returns (uint256) {
        return _testBlockTimestamp;
    }

    function _blockTimestamp() internal view override returns (uint256) {
        return _testBlockTimestamp;
    }

    //
    // BELOW WERE LEGACY EXTERNAL FUNCTION, MOVE TO HERE FOR THE TESTING, CAN BE REMOVE LATER ONCE WE CLEAN THE TESTS
    //

    struct SwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    function swap(SwapParams memory params) external nonReentrant() returns (IExchange.SwapResponse memory) {
        IAccountBalance(_accountBalance).registerBaseToken(_msgSender(), params.baseToken);
        (Funding.Growth memory fundingGrowthGlobal, , ) =
            TestAccountBalance(_accountBalance).getFundingGrowthGlobalAndTwaps(params.baseToken);

        return
            IExchange(_exchange).swap(
                IExchange.SwapParams({
                    trader: _msgSender(),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    isClose: false,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    fundingGrowthGlobal: fundingGrowthGlobal
                })
            );
    }

    // legacy function, leave it here for test case backward compatible
    function getTokenBalance(address trader, address baseToken) external view returns (int256 base, int256 quote) {
        {
            // getBase = takerBase - totalOrderDebt(base)
            // totalOrderDebt(base) = totalTokenAmountInPool(base) - makerBalance(base)
            uint256 totalTokenAmountInPool = IOrderBook(_orderBook).getTotalTokenAmountInPool(trader, baseToken, true);
            int256 makerBalance = IOrderBook(_orderBook).getMakerBalance(trader, baseToken, true);
            int256 totalOrderDebt = totalTokenAmountInPool.toInt256().sub(makerBalance);
            int256 takerBase = IAccountBalance(_accountBalance).getTakerPositionSize(trader, baseToken);
            base = takerBase.sub(totalOrderDebt);
        }
        {
            // getQuote = takerQuote - totalOrderDebt(quote)
            // totalOrderDebt(quote) = totalTokenAmountInPool(quote) - makerBalance(quote)
            uint256 totalTokenAmountInPool = IOrderBook(_orderBook).getTotalTokenAmountInPool(trader, baseToken, false);
            int256 makerBalance = IOrderBook(_orderBook).getMakerBalance(trader, baseToken, false);
            int256 totalOrderDebt = totalTokenAmountInPool.toInt256().sub(makerBalance);
            int256 takerQuote = IAccountBalance(_accountBalance).getTakerQuote(trader, baseToken);
            quote = takerQuote.sub(totalOrderDebt);
        }
    }
}
