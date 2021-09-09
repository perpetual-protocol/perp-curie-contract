// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { ClearingHouse } from "../ClearingHouse.sol";
import { Funding } from "../lib/Funding.sol";

contract TestClearingHouse is ClearingHouse {
    uint256 private _testBlockTimestamp;

    function __TestClearingHouse_init(
        address configArg,
        address vaultArg,
        address insuranceFundArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) external initializer {
        ClearingHouse.initialize(configArg, vaultArg, insuranceFundArg, quoteTokenArg, uniV3FactoryArg);
        _testBlockTimestamp = block.timestamp;
    }

    function setBlockTimestamp(uint256 blockTimestamp) external {
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

    function swap(SwapParams memory params) external nonReentrant() returns (SwapResponse memory) {
        _requireHasBaseToken(params.baseToken);
        _registerBaseToken(_msgSender(), params.baseToken);
        (Funding.Growth memory updatedGlobalFundingGrowth, , ) = _getUpdatedGlobalFundingGrowth(params.baseToken);

        return
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
                    trader: _msgSender(),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth
                })
            );
    }

    function mint(address token, uint256 amount) external nonReentrant() {
        if (token != quoteToken) {
            _requireHasBaseToken(token);
            _registerBaseToken(_msgSender(), token);
        }
        // always check margin ratio
        _mint(_msgSender(), token, amount, true);
    }

    function burn(address token) external nonReentrant() {
        if (token != quoteToken) {
            _requireHasBaseToken(token);
        }
        _burn(_msgSender(), token);
    }
}
