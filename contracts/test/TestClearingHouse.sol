// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { PerpSafeCast } from "../lib/PerpSafeCast.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
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
        address accountBalanceArg,
        address insuranceFundArg
    ) external initializer {
        ClearingHouse.initialize(
            configArg,
            vaultArg,
            quoteTokenArg,
            uniV3FactoryArg,
            exchangeArg,
            accountBalanceArg,
            insuranceFundArg
        );
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

    function setDelegateApprovalUnsafe(address delegateApprovalArg) external onlyOwner {
        _delegateApproval = delegateApprovalArg;
        emit DelegateApprovalChanged(delegateApprovalArg);
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

        IExchange.SwapResponse memory response =
            IExchange(_exchange).swap(
                IExchange.SwapParams({
                    trader: _msgSender(),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    isClose: false,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96
                })
            );

        IAccountBalance(_accountBalance).modifyTakerBalance(
            _msgSender(),
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional.sub(response.fee.toInt256())
        );

        if (response.pnlToBeRealized != 0) {
            IAccountBalance(_accountBalance).settleQuoteToOwedRealizedPnl(
                _msgSender(),
                params.baseToken,
                response.pnlToBeRealized
            );
        }
        return response;
    }

    function getTokenBalance(address trader, address baseToken) external view returns (int256, int256) {
        int256 base = IAccountBalance(_accountBalance).getBase(trader, baseToken);
        int256 quote = IAccountBalance(_accountBalance).getQuote(trader, baseToken);
        return (base, quote);
    }

    function isReversingPosition(int256 sizeBefore, int256 sizeAfter) external pure returns (bool) {
        return _isReversingPosition(sizeBefore, sizeAfter);
    }
}
